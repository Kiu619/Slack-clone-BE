/**
 * migrate-messages.mjs
 * Tạo tables: messages, reactions, attachments
 * Chạy: node scripts/migrate-messages.mjs
 */
import postgres from 'postgres'
import { config } from 'dotenv'

config()

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })

async function run() {
  console.log('🚀 Starting messages migration...')

  // 1. message_type enum
  console.log('Creating message_type enum...')
  await sql`
    DO $$ BEGIN
      CREATE TYPE message_type AS ENUM ('text', 'system');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `

  // 2. messages table
  console.log('Creating messages table...')
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id            text PRIMARY KEY,
      channel_id    text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content       text NOT NULL,
      type          message_type NOT NULL DEFAULT 'text',
      parent_id     text REFERENCES messages(id) ON DELETE SET NULL,
      edited_at     timestamp,
      deleted_at    timestamp,
      created_at    timestamp NOT NULL DEFAULT now(),
      updated_at    timestamp NOT NULL DEFAULT now()
    );
  `

  console.log('Creating messages indexes...')
  await sql`CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages(channel_id);`
  await sql`CREATE INDEX IF NOT EXISTS messages_user_idx ON messages(user_id);`
  await sql`CREATE INDEX IF NOT EXISTS messages_parent_idx ON messages(parent_id);`
  // Cursor pagination: lấy messages cũ hơn cursor, sort theo createdAt DESC
  await sql`CREATE INDEX IF NOT EXISTS messages_channel_created_idx ON messages(channel_id, created_at DESC);`

  // 3. reactions table
  console.log('Creating reactions table...')
  await sql`
    CREATE TABLE IF NOT EXISTS reactions (
      id          text PRIMARY KEY,
      message_id  text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji       text NOT NULL,
      created_at  timestamp NOT NULL DEFAULT now()
    );
  `

  console.log('Creating reactions indexes...')
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS reactions_unique
    ON reactions(message_id, user_id, emoji);
  `
  await sql`CREATE INDEX IF NOT EXISTS reactions_message_idx ON reactions(message_id);`
  await sql`CREATE INDEX IF NOT EXISTS reactions_user_idx ON reactions(user_id);`

  // 4. attachments table
  console.log('Creating attachments table...')
  await sql`
    CREATE TABLE IF NOT EXISTS attachments (
      id          text PRIMARY KEY,
      message_id  text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      url         text NOT NULL,
      type        text NOT NULL DEFAULT 'file',
      name        text NOT NULL,
      size        integer NOT NULL DEFAULT 0,
      created_at  timestamp NOT NULL DEFAULT now()
    );
  `

  await sql`CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id);`

  console.log('✅ Migration completed successfully!')
  await sql.end()
}

run().catch((e) => {
  console.error('❌ Migration failed:', e)
  process.exit(1)
})
