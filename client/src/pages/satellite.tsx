import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { ArrowLeft, Satellite, Plus, Trash2, Radio, Copy, Check, Signal, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface SatelliteDevice {
  id: string;
  userId: string;
  deviceType: string;
  deviceId: string;
  name: string;
  active: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

const DEVICE_TYPES = [
  { value: "garmin_inreach", label: "Garmin inReach" },
  { value: "spot", label: "SPOT" },
  { value: "somewear", label: "Somewear" },
  { value: "zoleo", label: "ZOLEO" },
  { value: "other", label: "Other" },
];

function getDeviceLabel(type: string) {
  return DEVICE_TYPES.find(d => d.value === type)?.label || type;
}

export default function SatellitePage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showAddForm, setShowAddForm] = useState(false);
  const [deviceType, setDeviceType] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [copiedWebhook, setCopiedWebhook] = useState(false);

  const { data: devices, isLoading } = useQuery<SatelliteDevice[]>({
    queryKey: ["/api/satellite/devices"],
  });

  const registerMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/satellite/register", {
        deviceType,
        deviceId: deviceId.trim(),
        name: deviceName.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/satellite/devices"] });
      toast({ title: "Device registered" });
      setShowAddForm(false);
      setDeviceType("");
      setDeviceId("");
      setDeviceName("");
    },
    onError: () => {
      toast({ title: "Could not register device", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/satellite/devices/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/satellite/devices"] });
      toast({ title: "Device removed" });
    },
    onError: () => {
      toast({ title: "Could not remove device", variant: "destructive" });
    },
  });

  const webhookUrl = `${window.location.origin}/api/satellite/webhook`;

  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopiedWebhook(true);
      toast({ title: "Webhook URL copied" });
      setTimeout(() => setCopiedWebhook(false), 2000);
    } catch {
      toast({ title: "Could not copy URL", variant: "destructive" });
    }
  };

  const canSubmit = deviceType && deviceId.trim() && deviceName.trim();

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="flex items-center gap-3 p-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")} data-testid="button-back-satellite">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold">Satellite devices</h1>
            <p className="text-xs text-muted-foreground">Stay connected off-grid</p>
          </div>
        </div>
      </div>

      <div className="p-4 max-w-lg mx-auto space-y-4">
        <Card data-testid="card-satellite-info">
          <CardContent className="pt-4">
            <div className="flex items-start gap-3">
              <Satellite className="h-8 w-8 text-primary shrink-0 mt-0.5" />
              <div>
                <h3 className="font-medium mb-1">How it works</h3>
                <p className="text-sm text-muted-foreground">
                  Connect your satellite communicator (Garmin inReach, SPOT, etc.) to StillHere. 
                  When you're out of cell range, your device can send checkins and SOS alerts 
                  through its satellite network, and we'll notify your emergency contacts just 
                  like a regular in-app alert.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-webhook-url">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Radio className="h-4 w-4" />
              Webhook URL
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-2">
              Configure your satellite device to send messages to this URL. 
              Use action "checkin" for safety checkins and "sos" for emergencies.
            </p>
            <div className="flex gap-2">
              <Input
                value={webhookUrl}
                readOnly
                className="text-xs font-mono"
                data-testid="input-webhook-url"
              />
              <Button variant="outline" size="icon" onClick={copyWebhook} data-testid="button-copy-webhook">
                {copiedWebhook ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="mt-3 p-3 bg-muted rounded-lg">
              <p className="text-xs font-medium mb-1">Webhook payload format:</p>
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
{`POST ${webhookUrl}
{
  "deviceId": "your-device-id",
  "action": "checkin" or "sos",
  "lat": 51.5074,  // optional
  "lng": -0.1278   // optional
}`}
              </pre>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          <h3 className="font-medium">Your devices</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddForm(!showAddForm)}
            data-testid="button-add-device"
          >
            <Plus className="h-4 w-4 mr-1" />
            Add device
          </Button>
        </div>

        {showAddForm && (
          <Card className="border-primary/30" data-testid="card-add-device">
            <CardContent className="pt-4 space-y-3">
              <div>
                <Label htmlFor="device-type">Device type</Label>
                <Select value={deviceType} onValueChange={setDeviceType}>
                  <SelectTrigger id="device-type" data-testid="select-device-type">
                    <SelectValue placeholder="Select your device" />
                  </SelectTrigger>
                  <SelectContent>
                    {DEVICE_TYPES.map(dt => (
                      <SelectItem key={dt.value} value={dt.value}>{dt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="device-id">Device ID / IMEI</Label>
                <Input
                  id="device-id"
                  placeholder="e.g. 300234010123456"
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  data-testid="input-device-id"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Found in your device settings or on the device itself
                </p>
              </div>
              <div>
                <Label htmlFor="device-name">Nickname</Label>
                <Input
                  id="device-name"
                  placeholder="e.g. My inReach Mini"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  data-testid="input-device-name"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => registerMutation.mutate()}
                  disabled={!canSubmit || registerMutation.isPending}
                  className="flex-1"
                  data-testid="button-register-device"
                >
                  {registerMutation.isPending ? "Registering..." : "Register device"}
                </Button>
                <Button variant="ghost" onClick={() => setShowAddForm(false)} data-testid="button-cancel-add">
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="text-center py-8">
            <div className="w-8 h-8 border-3 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        ) : devices && devices.length > 0 ? (
          <div className="space-y-3">
            {devices.map((device) => (
              <Card key={device.id} data-testid={`card-device-${device.id}`}>
                <CardContent className="py-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <Signal className={`h-5 w-5 mt-0.5 ${device.active ? "text-green-500" : "text-muted-foreground"}`} />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium" data-testid={`text-device-name-${device.id}`}>{device.name}</span>
                          <Badge variant="outline" className="text-xs">
                            {getDeviceLabel(device.deviceType)}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                          ID: {device.deviceId}
                        </p>
                        <div className="flex items-center gap-1 mt-1">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">
                            {device.lastSeenAt
                              ? `Last seen: ${new Date(device.lastSeenAt).toLocaleString()}`
                              : "No activity yet"}
                          </span>
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteMutation.mutate(device.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-device-${device.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-muted-foreground" data-testid="text-no-devices">
            <Satellite className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p>No satellite devices registered</p>
            <p className="text-sm mt-1">Add a device to get started</p>
          </div>
        )}
      </div>
    </div>
  );
}
