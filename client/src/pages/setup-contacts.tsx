import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Users, UserPlus, Trash2, GripVertical } from "lucide-react";

interface ContactEntry {
  name: string;
  phone: string;
}

export default function SetupContactsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [contacts, setContacts] = useState<ContactEntry[]>([
    { name: "", phone: "" },
  ]);

  const contactsMutation = useMutation({
    mutationFn: async (contactsList: ContactEntry[]) => {
      return apiRequest("POST", "/api/contacts", {
        contacts: contactsList.map((c, i) => ({
          name: c.name,
          phone: c.phone,
          priority: i + 1,
        })),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      setLocation("/setup/preferences");
    },
    onError: (error: any) => {
      if (error?.requiresLogin) {
        setLocation("/login");
        return;
      }
      toast({
        title: "Error",
        description: "Could not save contacts. Please try again.",
        variant: "destructive",
      });
    },
  });

  const addContact = () => {
    if (contacts.length >= 2) return;
    setContacts([...contacts, { name: "", phone: "" }]);
  };

  const removeContact = (index: number) => {
    if (contacts.length <= 1) return;
    setContacts(contacts.filter((_, i) => i !== index));
  };

  const updateContact = (index: number, field: keyof ContactEntry, value: string) => {
    const updated = [...contacts];
    updated[index] = { ...updated[index], [field]: value };
    setContacts(updated);
  };

  const moveContact = (from: number, to: number) => {
    if (to < 0 || to >= contacts.length) return;
    const updated = [...contacts];
    const [moved] = updated.splice(from, 1);
    updated.splice(to, 0, moved);
    setContacts(updated);
  };

  const canSubmit = contacts.length > 0 && contacts[0].name.trim() && contacts[0].phone.trim();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const valid = contacts.filter(c => c.name.trim() && c.phone.trim());
    if (valid.length === 0) {
      toast({ title: "Error", description: "At least one contact is required.", variant: "destructive" });
      return;
    }
    contactsMutation.mutate(valid);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center mx-auto mb-4">
            <Users className="h-8 w-8 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl" data-testid="text-setup-contacts-title">
            Emergency contacts
          </CardTitle>
          <CardDescription className="text-base mt-2">
            Who should we notify if you don't check in?
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-6">
            {contacts.map((contact, index) => (
              <div key={index} className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">
                    {index === 0 ? "Primary contact" : `Contact ${index + 1}`}
                  </Label>
                  <div className="flex items-center gap-1">
                    {contacts.length > 1 && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => moveContact(index, index - 1)}
                          disabled={index === 0}
                          data-testid={`button-move-up-${index}`}
                        >
                          <GripVertical className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-destructive"
                          onClick={() => removeContact(index)}
                          data-testid={`button-remove-contact-${index}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <Input
                  placeholder="Name"
                  value={contact.name}
                  onChange={(e) => updateContact(index, "name", e.target.value)}
                  data-testid={`input-contact-name-${index}`}
                />
                <Input
                  placeholder="Mobile number"
                  type="tel"
                  value={contact.phone}
                  onChange={(e) => updateContact(index, "phone", e.target.value)}
                  data-testid={`input-contact-phone-${index}`}
                />
              </div>
            ))}

            {contacts.length < 2 && (
              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={addContact}
                data-testid="button-add-contact"
              >
                <UserPlus className="h-4 w-4 mr-2" />
                Add a backup contact
              </Button>
            )}

            <Button
              type="submit"
              className="w-full"
              size="lg"
              disabled={contactsMutation.isPending || !canSubmit}
              data-testid="button-continue"
            >
              {contactsMutation.isPending ? "Saving..." : "Continue"}
            </Button>
          </form>

          <div className="flex justify-center gap-2 mt-6">
            <div className="w-2 h-2 rounded-full bg-primary" />
            <div className="w-2 h-2 rounded-full bg-primary" />
            <div className="w-2 h-2 rounded-full bg-muted" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
