import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Users, UserPlus } from "lucide-react";

const contactsSchema = z.object({
  contact1Name: z.string().min(1, "Name is required"),
  contact1Phone: z.string().min(1, "Phone number is required"),
  contact2Name: z.string().optional(),
  contact2Phone: z.string().optional(),
});

type ContactsForm = z.infer<typeof contactsSchema>;

export default function SetupContactsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showContact2, setShowContact2] = useState(false);

  const form = useForm<ContactsForm>({
    resolver: zodResolver(contactsSchema),
    defaultValues: {
      contact1Name: "",
      contact1Phone: "",
      contact2Name: "",
      contact2Phone: "",
    },
  });

  const contactsMutation = useMutation({
    mutationFn: async (data: ContactsForm) => {
      return apiRequest("POST", "/api/contacts", data);
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

  const onSubmit = (data: ContactsForm) => {
    contactsMutation.mutate(data);
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
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="space-y-3">
                <Label className="text-sm font-medium">Primary contact</Label>
                <FormField
                  control={form.control}
                  name="contact1Name"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Input 
                          placeholder="Name" 
                          {...field} 
                          data-testid="input-contact1-name" 
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="contact1Phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Input 
                          placeholder="Mobile number" 
                          type="tel"
                          {...field} 
                          data-testid="input-contact1-phone" 
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {showContact2 ? (
                <div className="space-y-3">
                  <Label className="text-sm font-medium">Backup contact (optional)</Label>
                  <FormField
                    control={form.control}
                    name="contact2Name"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <Input 
                            placeholder="Name" 
                            {...field} 
                            data-testid="input-contact2-name" 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="contact2Phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <Input 
                            placeholder="Mobile number" 
                            type="tel"
                            {...field} 
                            data-testid="input-contact2-phone" 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-muted-foreground"
                  onClick={() => setShowContact2(true)}
                  data-testid="button-add-contact2"
                >
                  <UserPlus className="h-4 w-4 mr-2" />
                  Add a backup contact
                </Button>
              )}

              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={contactsMutation.isPending}
                data-testid="button-continue"
              >
                {contactsMutation.isPending ? "Saving..." : "Continue"}
              </Button>
            </form>
          </Form>

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
