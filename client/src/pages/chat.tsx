import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Send, Video, CheckCheck, Check, Lock, RotateCcw } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { getSocket } from "@/lib/socket";
import type { Message } from "@shared/schema";
import { format } from "date-fns";
import {
  getOrCreateKeyPair,
  exportPublicKeyString,
  encryptMessage,
  decryptMessage,
} from "@/lib/e2e-crypto";

interface DecryptedMessage extends Message {
  decryptedContent?: string;
  sendFailed?: boolean;
  optimisticId?: string;
}

export default function ChatPage() {
  const { userId: otherUserId } = useParams<{ userId: string }>();
  const [, setLocation] = useLocation();
  const { auth } = useAuth();
  const [newMessage, setNewMessage] = useState("");
  const [isOtherTyping, setIsOtherTyping] = useState(false);
  const [localMessages, setLocalMessages] = useState<DecryptedMessage[]>([]);
  const [e2eReady, setE2eReady] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentUserId = auth?.user?.id;
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingStaleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const privateKeyRef = useRef<CryptoKey | null>(null);
  const otherPublicKeyRef = useRef<string | null>(null);
  const lastFetchedRef = useRef<string>("");
  const optimisticCounterRef = useRef(0);

  const { data: userProfile } = useQuery<{ id: string; name: string; publicKey?: string | null }>({
    queryKey: ["/api/users", otherUserId, "profile"],
    enabled: !!otherUserId,
  });

  const otherUserName = userProfile?.name || "User";

  const { data: serverMessages = [], isLoading } = useQuery<Message[]>({
    queryKey: ["/api/messages", otherUserId],
    enabled: !!otherUserId,
  });

  useEffect(() => {
    async function setupE2E() {
      try {
        const { publicKey, privateKey } = await getOrCreateKeyPair();
        privateKeyRef.current = privateKey;
        const pubKeyStr = exportPublicKeyString(publicKey);
        await apiRequest("POST", "/api/users/public-key", { publicKey: pubKeyStr });
        setE2eReady(true);
      } catch (err) {
        console.warn("[E2E] Setup failed, messages will be unencrypted:", err);
      }
    }
    setupE2E();
  }, []);

  useEffect(() => {
    if (userProfile?.publicKey) {
      otherPublicKeyRef.current = userProfile.publicKey;
    }
  }, [userProfile?.publicKey]);

  const decryptMessages = useCallback(async (msgs: Message[]): Promise<DecryptedMessage[]> => {
    const results: DecryptedMessage[] = [];
    for (const msg of msgs) {
      if (msg.encrypted && msg.iv) {
        const otherKey = msg.senderId === currentUserId
          ? otherPublicKeyRef.current
          : userProfile?.publicKey;
        if (otherKey && privateKeyRef.current) {
          try {
            const decrypted = await decryptMessage(msg.content, msg.iv, privateKeyRef.current, otherKey);
            results.push({ ...msg, decryptedContent: decrypted });
          } catch {
            results.push({ ...msg, decryptedContent: "[Encrypted message]" });
          }
        } else {
          results.push({ ...msg, decryptedContent: "[Encrypted message]" });
        }
      } else {
        results.push({ ...msg, decryptedContent: msg.content });
      }
    }
    return results;
  }, [currentUserId, userProfile?.publicKey]);

  useEffect(() => {
    const key = JSON.stringify(serverMessages.map(m => m.id));
    if (key === lastFetchedRef.current) return;
    lastFetchedRef.current = key;

    decryptMessages(serverMessages).then(decrypted => {
      setLocalMessages(prev => {
        const optimistic = prev.filter(m => m.id.startsWith("optimistic-"));
        return [...decrypted, ...optimistic];
      });
    });
  }, [serverMessages, decryptMessages]);

  useEffect(() => {
    if (e2eReady && otherPublicKeyRef.current && privateKeyRef.current) {
      setLocalMessages(prev => {
        const needsRedecrypt = prev.some(m => m.encrypted && m.decryptedContent === "[Encrypted message]");
        if (!needsRedecrypt) return prev;
        decryptMessages(prev.filter(m => !m.id.startsWith("optimistic-"))).then(decrypted => {
          setLocalMessages(old => {
            const optimistic = old.filter(m => m.id.startsWith("optimistic-"));
            return [...decrypted, ...optimistic];
          });
        });
        return prev;
      });
    }
  }, [e2eReady, userProfile?.publicKey, decryptMessages]);

  useEffect(() => {
    if (!otherUserId || !currentUserId) return;
    const socket = getSocket();

    const handleNewMessage = async (msg: any) => {
      if (msg.senderId === otherUserId) {
        let decryptedContent = msg.content;
        if (msg.encrypted) {
          decryptedContent = "[Encrypted message]";
          if (msg.iv && privateKeyRef.current && userProfile?.publicKey) {
            try {
              decryptedContent = await decryptMessage(msg.content, msg.iv, privateKeyRef.current, userProfile.publicKey);
            } catch {
              decryptedContent = "[Encrypted message]";
            }
          }
        }
        setLocalMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev;
          return [...prev, { ...msg, decryptedContent }];
        });
        setIsOtherTyping(false);
        socket.emit("message:read", { senderId: otherUserId });
        queryClient.invalidateQueries({ queryKey: ["/api/messages/unread/count"] });
        queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      }
    };

    const handleMessageSent = async (msg: any) => {
      if (msg.receiverId === otherUserId) {
        setLocalMessages(prev => {
          const oldest = prev.find(m => m.id.startsWith("optimistic-"));
          let plainContent = oldest?.decryptedContent;
          if (!plainContent) {
            plainContent = msg.encrypted ? "[Encrypted message]" : msg.content;
          }
          const updated = prev.filter(m => m !== oldest);
          if (updated.some(m => m.id === msg.id)) return updated;
          return [...updated, { ...msg, decryptedContent: plainContent }];
        });
        queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      }
    };

    const handleTypingStart = (data: { userId: string }) => {
      if (data.userId === otherUserId) {
        setIsOtherTyping(true);
        if (typingStaleRef.current) clearTimeout(typingStaleRef.current);
        typingStaleRef.current = setTimeout(() => setIsOtherTyping(false), 5000);
      }
    };

    const handleTypingStop = (data: { userId: string }) => {
      if (data.userId === otherUserId) {
        setIsOtherTyping(false);
        if (typingStaleRef.current) { clearTimeout(typingStaleRef.current); typingStaleRef.current = null; }
      }
    };

    const handleReadReceipt = (data: { readBy: string }) => {
      if (data.readBy === otherUserId) {
        setLocalMessages(prev => prev.map(m =>
          m.senderId === currentUserId ? { ...m, read: true } : m
        ));
      }
    };

    socket.on("message:new", handleNewMessage);
    socket.on("message:sent", handleMessageSent);
    socket.on("typing:start", handleTypingStart);
    socket.on("typing:stop", handleTypingStop);
    socket.on("message:read-receipt", handleReadReceipt);

    socket.emit("message:read", { senderId: otherUserId });
    apiRequest("POST", `/api/messages/${otherUserId}/read`, {}).then(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages/unread/count"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    }).catch(() => {});

    return () => {
      socket.off("message:new", handleNewMessage);
      socket.off("message:sent", handleMessageSent);
      socket.off("typing:start", handleTypingStart);
      socket.off("typing:stop", handleTypingStop);
      socket.off("message:read-receipt", handleReadReceipt);
      if (isTypingRef.current) {
        socket.emit("typing:stop", { receiverId: otherUserId });
      }
      if (typingStaleRef.current) clearTimeout(typingStaleRef.current);
    };
  }, [otherUserId, currentUserId, userProfile?.publicKey]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [localMessages, isOtherTyping]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setNewMessage(e.target.value);
    if (!otherUserId) return;
    const socket = getSocket();

    if (!isTypingRef.current && e.target.value.trim()) {
      isTypingRef.current = true;
      socket.emit("typing:start", { receiverId: otherUserId });
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      if (isTypingRef.current) {
        isTypingRef.current = false;
        socket.emit("typing:stop", { receiverId: otherUserId });
      }
    }, 2000);

    if (!e.target.value.trim() && isTypingRef.current) {
      isTypingRef.current = false;
      socket.emit("typing:stop", { receiverId: otherUserId });
    }
  }

  async function handleSend(retryText?: string) {
    const text = retryText || newMessage.trim();
    if (!text || !otherUserId) return;

    if (!retryText) setNewMessage("");
    if (isTypingRef.current) {
      isTypingRef.current = false;
      getSocket().emit("typing:stop", { receiverId: otherUserId });
    }

    const optimisticId = `optimistic-${++optimisticCounterRef.current}`;
    const optimisticMsg: DecryptedMessage = {
      id: optimisticId,
      senderId: currentUserId!,
      receiverId: otherUserId,
      content: text,
      read: false,
      encrypted: false,
      iv: null,
      createdAt: new Date(),
      decryptedContent: text,
    };
    setLocalMessages(prev => prev.filter(m => !(m.sendFailed && m.decryptedContent === text)).concat([optimisticMsg]));

    const socket = getSocket();
    const canEncrypt = e2eReady && privateKeyRef.current && otherPublicKeyRef.current;

    const sendPayload: any = { receiverId: otherUserId, content: text };

    if (canEncrypt) {
      try {
        const { ciphertext, iv } = await encryptMessage(text, privateKeyRef.current!, otherPublicKeyRef.current!);
        sendPayload.content = ciphertext;
        sendPayload.encrypted = true;
        sendPayload.iv = iv;
      } catch (err) {
        console.warn("[E2E] Encryption failed, sending unencrypted:", err);
      }
    }

    socket.emit("message:send", sendPayload, (response: any) => {
      if (!response?.success) {
        setLocalMessages(prev => prev.map(m =>
          m.id === optimisticId ? { ...m, sendFailed: true } : m
        ));
      }
    });

    setTimeout(() => {
      setLocalMessages(prev => {
        const msg = prev.find(m => m.id === optimisticId);
        if (msg && !msg.sendFailed) {
          return prev.map(m => m.id === optimisticId ? { ...m, sendFailed: true } : m);
        }
        return prev;
      });
    }, 10000);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col" data-testid="chat-page">
      <div className="border-b px-4 py-3 flex items-center gap-3 bg-card">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => window.history.length > 1 ? window.history.back() : setLocation("/")}
          data-testid="button-back-chat"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-medium" data-testid="text-chat-user-name">{otherUserName}</h2>
            {e2eReady && otherPublicKeyRef.current && (
              <Lock className="w-3.5 h-3.5 text-green-500" />
            )}
          </div>
          {isOtherTyping && (
            <p className="text-xs text-primary animate-pulse" data-testid="text-typing-indicator">typing...</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLocation(`/call/${otherUserId}`)}
          data-testid="button-video-call"
        >
          <Video className="w-5 h-5" />
        </Button>
      </div>

      {e2eReady && otherPublicKeyRef.current && (
        <div className="bg-green-50 dark:bg-green-950/30 text-center py-1.5 px-4">
          <p className="text-[11px] text-green-600 dark:text-green-400 flex items-center justify-center gap-1" data-testid="text-e2e-banner">
            <Lock className="w-3 h-3" />
            Messages are end-to-end encrypted
          </p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2 max-w-lg mx-auto w-full">
        {isLoading && (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isLoading && localMessages.length === 0 && (
          <div className="text-center text-muted-foreground py-12 text-sm">
            <p data-testid="text-no-messages">No messages yet. Say hello!</p>
          </div>
        )}

        {localMessages.map((msg) => {
          const isMine = msg.senderId === currentUserId;
          const isOptimistic = msg.id.startsWith("optimistic-");
          const content = msg.decryptedContent ?? (msg.encrypted ? "[Encrypted message]" : msg.content);
          return (
            <div
              key={msg.id}
              className={`flex ${isMine ? "justify-end" : "justify-start"}`}
              data-testid={`message-${msg.id}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                  isMine
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted rounded-bl-sm"
                } ${isOptimistic && !msg.sendFailed ? "opacity-70" : ""} ${msg.sendFailed ? "opacity-50" : ""}`}
              >
                <p className="text-sm whitespace-pre-wrap break-words">{content}</p>
                <div className={`flex items-center gap-1 mt-1 ${isMine ? "justify-end" : ""}`}>
                  {msg.sendFailed ? (
                    <button
                      onClick={() => {
                        setLocalMessages(prev => prev.filter(m => m.id !== msg.id));
                        handleSend(content);
                      }}
                      className="flex items-center gap-1 text-[10px] text-red-300 hover:text-red-200"
                      data-testid={`button-retry-${msg.id}`}
                    >
                      <RotateCcw className="w-3 h-3" /> Tap to retry
                    </button>
                  ) : (
                    <>
                      <span className={`text-[10px] ${isMine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                        {isOptimistic ? "Sending..." : format(new Date(msg.createdAt), "h:mm a")}
                      </span>
                      {isMine && !isOptimistic && (
                        msg.read
                          ? <CheckCheck className="w-3 h-3 text-primary-foreground/70" />
                          : <Check className="w-3 h-3 text-primary-foreground/70" />
                      )}
                      {msg.encrypted && !isOptimistic && (
                        <Lock className="w-2.5 h-2.5 text-primary-foreground/50" />
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {isOtherTyping && (
          <div className="flex justify-start" data-testid="typing-bubble">
            <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="border-t px-4 py-3 bg-card">
        <div className="max-w-lg mx-auto flex gap-2">
          <Input
            ref={inputRef}
            value={newMessage}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            className="flex-1"
            data-testid="input-message"
          />
          <Button
            onClick={() => handleSend()}
            disabled={!newMessage.trim()}
            size="icon"
            data-testid="button-send-message"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
