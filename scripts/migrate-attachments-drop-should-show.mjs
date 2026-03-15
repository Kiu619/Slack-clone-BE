/**
 * Migration: Xóa cột should_show khỏi bảng attachments
 *
 * Run: node scripts/migrate-attachments-drop-should-show.mjs
 */

import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

async function migrate() {
  console.log('🚀 Starting migration: drop should_show from attachments...')

  try {
    await sql`ALTER TABLE attachments DROP COLUMN IF EXISTS should_show`
    console.log('✅ Migration completed!')
  } catch (error) {
    console.error('❌ Migration failed:', error)
    throw error
  } finally {
    await sql.end()
  }
}

migrate()
