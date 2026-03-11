import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Send, Video, CheckCheck, Check } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { getSocket } from "@/lib/socket";
import type { Message } from "@shared/schema";
import { format } from "date-fns";

export default function ChatPage() {
  const { userId: otherUserId } = useParams<{ userId: string }>();
  const [, setLocation] = useLocation();
  const { auth } = useAuth();
  const [newMessage, setNewMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentUserId = auth?.user?.id;

  const { data: messages = [], isLoading } = useQuery<Message[]>({
    queryKey: ["/api/messages", otherUserId],
    refetchInterval: 10000,
  });

  const { data: watchedUsers } = useQuery<any[]>({
    queryKey: ["/api/watched-users"],
  });

  const otherUserName = watchedUsers?.find((u: any) => u.userId === otherUserId)?.userName || "User";

  const sendMutation = useMutation({
    mutationFn: async (content: string) => {
      const res = await apiRequest("POST", `/api/messages/${otherUserId}`, { content });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages", otherUserId] });
      setNewMessage("");
    },
  });

  useEffect(() => {
    const socket = getSocket();

    const handleNewMessage = (msg: any) => {
      if (msg.senderId === otherUserId || msg.receiverId === otherUserId) {
        queryClient.invalidateQueries({ queryKey: ["/api/messages", otherUserId] });
      }
    };

    socket.on("message:new", handleNewMessage);

    apiRequest("POST", `/api/messages/${otherUserId}/read`, {}).catch(() => {});

    return () => {
      socket.off("message:new", handleNewMessage);
    };
  }, [otherUserId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSend() {
    if (!newMessage.trim()) return;
    sendMutation.mutate(newMessage.trim());
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="border-b px-4 py-3 flex items-center gap-3 bg-card">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLocation("/watched")}
          data-testid="button-back-chat"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h2 className="font-medium" data-testid="text-chat-user-name">{otherUserName}</h2>
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

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2 max-w-lg mx-auto w-full">
        {isLoading && (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isLoading && messages.length === 0 && (
          <div className="text-center text-muted-foreground py-12 text-sm">
            <p data-testid="text-no-messages">No messages yet. Say hello!</p>
          </div>
        )}

        {messages.map((msg) => {
          const isMine = msg.senderId === currentUserId;
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
                }`}
              >
                <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                <div className={`flex items-center gap-1 mt-1 ${isMine ? "justify-end" : ""}`}>
                  <span className={`text-[10px] ${isMine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                    {format(new Date(msg.createdAt), "h:mm a")}
                  </span>
                  {isMine && (
                    msg.read
                      ? <CheckCheck className="w-3 h-3 text-primary-foreground/70" />
                      : <Check className="w-3 h-3 text-primary-foreground/70" />
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t px-4 py-3 bg-card">
        <div className="max-w-lg mx-auto flex gap-2">
          <Input
            ref={inputRef}
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            className="flex-1"
            data-testid="input-message"
          />
          <Button
            onClick={handleSend}
            disabled={!newMessage.trim() || sendMutation.isPending}
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
