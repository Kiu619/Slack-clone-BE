/**
 * Migration: Thêm fields mới vào attachments table
 * - mimeType: MIME type của file (e.g., "image/png", "application/pdf")
 * - width: chiều rộng (px) cho image/video
 * - height: chiều cao (px) cho image/video
 * - duration: độ dài (giây) cho video/audio
 *
 * Run: node scripts/migrate-attachments-fields.mjs
 */

import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

async function migrate() {
  console.log('🚀 Starting migration: add fields to attachments table...')

  try {
    // Thêm các columns mới
    await sql`
      ALTER TABLE attachments
      ADD COLUMN IF NOT EXISTS mime_type TEXT,
      ADD COLUMN IF NOT EXISTS width INTEGER,
      ADD COLUMN IF NOT EXISTS height INTEGER,
      ADD COLUMN IF NOT EXISTS duration INTEGER
    `

    console.log('✅ Migration completed successfully!')
  } catch (error) {
    console.error('❌ Migration failed:', error)
    throw error
  } finally {
    await sql.end()
  }
}

migrate()
