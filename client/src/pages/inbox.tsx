import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, MessageCircle, MessageSquare } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { getSocket } from "@/lib/socket";
import { queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";

interface Conversation {
  partnerId: string;
  partnerName: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
}

export default function InboxPage() {
  const [, setLocation] = useLocation();
  const { auth } = useAuth();

  const { data: conversations, isLoading } = useQuery<Conversation[]>({
    queryKey: ["/api/conversations"],
    refetchInterval: 30000,
  });

  const totalUnread = conversations?.reduce((sum, c) => sum + c.unreadCount, 0) || 0;

  useEffect(() => {
    if (!auth?.authenticated) return;
    const socket = getSocket();

    const handleNewMessage = () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/messages/unread/count"] });
    };

    socket.on("message:new", handleNewMessage);
    return () => { socket.off("message:new", handleNewMessage); };
  }, [auth?.authenticated]);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-lg mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/")} data-testid="button-back">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-xl font-semibold" data-testid="text-page-title">Messages</h1>
            {totalUnread > 0 && (
              <p className="text-sm text-primary" data-testid="text-unread-total">
                {totalUnread} unread message{totalUnread !== 1 ? "s" : ""}
              </p>
            )}
            {totalUnread === 0 && conversations && conversations.length > 0 && (
              <p className="text-sm text-muted-foreground">All caught up</p>
            )}
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isLoading && (!conversations || conversations.length === 0) && (
          <Card>
            <CardContent className="py-12 text-center">
              <MessageSquare className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="font-medium text-lg mb-2" data-testid="text-empty-state">No messages yet</h3>
              <p className="text-muted-foreground text-sm">
                Messages from your emergency contacts and watchers will appear here.
              </p>
            </CardContent>
          </Card>
        )}

        {conversations && conversations.length > 0 && (
          <div className="space-y-2">
            {conversations.map((convo) => (
              <Card
                key={convo.partnerId}
                className={`cursor-pointer transition-colors hover:bg-accent/50 ${convo.unreadCount > 0 ? "border-primary/30 bg-primary/5" : ""}`}
                onClick={() => setLocation(`/chat/${convo.partnerId}`)}
                data-testid={`conversation-${convo.partnerId}`}
              >
                <CardContent className="py-3 px-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${convo.unreadCount > 0 ? "bg-primary/10" : "bg-muted"}`}>
                      <MessageCircle className={`w-5 h-5 ${convo.unreadCount > 0 ? "text-primary" : "text-muted-foreground"}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className={`text-sm truncate ${convo.unreadCount > 0 ? "font-semibold" : "font-medium"}`} data-testid={`text-partner-name-${convo.partnerId}`}>
                          {convo.partnerName}
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0 ml-2" data-testid={`text-time-${convo.partnerId}`}>
                          {formatDistanceToNow(new Date(convo.lastMessageAt), { addSuffix: true })}
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-0.5">
                        <p className={`text-sm truncate ${convo.unreadCount > 0 ? "text-foreground" : "text-muted-foreground"}`} data-testid={`text-preview-${convo.partnerId}`}>
                          {convo.lastMessage.length > 60 ? convo.lastMessage.substring(0, 60) + "..." : convo.lastMessage}
                        </p>
                        {convo.unreadCount > 0 && (
                          <Badge className="ml-2 shrink-0 bg-primary text-primary-foreground text-xs min-w-[20px] h-5 flex items-center justify-center rounded-full" data-testid={`badge-unread-${convo.partnerId}`}>
                            {convo.unreadCount}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
