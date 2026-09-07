CREATE TABLE "incident_escalation_sequence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"priority_rank" integer NOT NULL,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	"destination" text NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_escalation_sequence_priority_rank_check" CHECK ("incident_escalation_sequence"."priority_rank" > 0)
);

--> statement-breakpoint
CREATE TABLE "incident_contact_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"sequence_id" uuid,
	"cycle" integer DEFAULT 1 NOT NULL,
	"channel" text DEFAULT 'voice' NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"parent_call_sid" text,
	"child_call_sid" text,
	"attempted_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration" integer,
	"outcome" text,
	"outcome_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_contact_attempts_cycle_check" CHECK ("incident_contact_attempts"."cycle" = 1),
	CONSTRAINT "incident_contact_attempts_duration_check" CHECK ("incident_contact_attempts"."duration" >= 0),
	CONSTRAINT "incident_contact_attempts_outcome_source_check" CHECK ("incident_contact_attempts"."outcome_source" IN ('provider_authoritative','duration_inferred','system_inferred'))
);

--> statement-breakpoint
CREATE TABLE "incident_telephony_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"attempt_id" uuid,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"call_status" text,
	"dial_call_status" text,
	"dial_call_duration" text,
	"call_duration" text,
	"call_sid" text,
	"parent_call_sid" text,
	"dial_call_sid" text,
	"answered_by" text,
	"digits" text,
	"provider_timestamp" text,
	"sequence_number" text,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "escalation_snapshot_created_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "escalation_snapshot_contact_count" integer;
--> statement-breakpoint
ALTER TABLE "incident_escalation_sequence" ADD CONSTRAINT "incident_escalation_sequence_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "incident_contact_attempts" ADD CONSTRAINT "incident_contact_attempts_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "incident_contact_attempts" ADD CONSTRAINT "incident_contact_attempts_sequence_id_incident_escalation_sequence_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."incident_escalation_sequence"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "incident_telephony_events" ADD CONSTRAINT "incident_telephony_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "incident_telephony_events" ADD CONSTRAINT "incident_telephony_events_attempt_id_incident_contact_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."incident_contact_attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "incident_sequence_rank_unique" ON "incident_escalation_sequence" USING btree ("incident_id","priority_rank");
--> statement-breakpoint
CREATE UNIQUE INDEX "incident_sequence_contact_unique" ON "incident_escalation_sequence" USING btree ("incident_id","contact_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "incident_attempt_cycle_contact_unique" ON "incident_contact_attempts" USING btree ("incident_id","cycle","sequence_id","channel");
--> statement-breakpoint
CREATE UNIQUE INDEX "incident_attempt_child_sid_unique" ON "incident_contact_attempts" USING btree ("child_call_sid");
--> statement-breakpoint
CREATE INDEX "incident_attempt_parent_sid_idx" ON "incident_contact_attempts" USING btree ("parent_call_sid");
--> statement-breakpoint
CREATE UNIQUE INDEX "incident_telephony_event_key_unique" ON "incident_telephony_events" USING btree ("event_key");
--> statement-breakpoint
CREATE INDEX "incident_telephony_event_attempt_idx" ON "incident_telephony_events" USING btree ("attempt_id","created_at");
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incident_snapshot_metadata_pair" CHECK (("incidents"."escalation_snapshot_created_at" IS NULL AND "incidents"."escalation_snapshot_contact_count" IS NULL) OR ("incidents"."escalation_snapshot_created_at" IS NOT NULL AND "incidents"."escalation_snapshot_contact_count" IS NOT NULL AND "incidents"."escalation_snapshot_contact_count" >= 0));
