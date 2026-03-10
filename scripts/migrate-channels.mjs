import postgres from 'postgres'
import { config } from 'dotenv'

config()

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })

async function run() {
  console.log('Creating channel_type enum...')
  await sql`
    DO $$ BEGIN
      CREATE TYPE channel_type AS ENUM ('text', 'audio', 'video');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `

  console.log('Creating channels table...')
  await sql`
    CREATE TABLE IF NOT EXISTS channels (
      id          text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name        text NOT NULL,
      slug        text NOT NULL,
      type        channel_type NOT NULL DEFAULT 'text',
      is_private  boolean NOT NULL DEFAULT false,
      description text,
      created_by_id text REFERENCES users(id) ON DELETE SET NULL,
      created_at  timestamp NOT NULL DEFAULT now(),
      updated_at  timestamp NOT NULL DEFAULT now()
    );
  `

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS channels_workspace_slug_unique
      ON channels (workspace_id, slug);
  `

  await sql`
    CREATE INDEX IF NOT EXISTS channels_workspace_idx ON channels (workspace_id);
  `

  console.log('Creating channel_members table...')
  await sql`
    CREATE TABLE IF NOT EXISTS channel_members (
      id         text PRIMARY KEY,
      channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at  timestamp NOT NULL DEFAULT now()
    );
  `

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS channel_members_unique
      ON channel_members (channel_id, user_id);
  `

  await sql`
    CREATE INDEX IF NOT EXISTS channel_members_channel_idx ON channel_members (channel_id);
  `

  await sql`
    CREATE INDEX IF NOT EXISTS channel_members_user_idx ON channel_members (user_id);
  `

  console.log('Done!')
  await sql.end()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
