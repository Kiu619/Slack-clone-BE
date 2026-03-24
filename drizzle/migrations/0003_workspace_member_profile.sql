-- Per-workspace profile on workspace_members; users keeps account defaults (name, avatar only)

ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "name" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "avatar" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "is_away" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "status" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "name_pronunciation" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "time_zone" text;--> statement-breakpoint

UPDATE "workspace_members" wm
SET
  "name" = u."name",
  "display_name" = u."display_name",
  "avatar" = u."avatar",
  "is_away" = u."is_away",
  "status" = u."status",
  "name_pronunciation" = u."name_pronunciation",
  "phone" = u."phone",
  "description" = u."description",
  "time_zone" = u."time_zone"
FROM "users" u
WHERE wm."user_id" = u."id";--> statement-breakpoint

ALTER TABLE "users" DROP COLUMN IF EXISTS "display_name";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "is_away";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "name_pronunciation";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "phone";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "description";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "time_zone";
