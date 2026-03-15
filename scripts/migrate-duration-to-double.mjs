/**
 * Migration: Đổi cột duration từ INTEGER sang DOUBLE PRECISION
 * Vì Cloudinary trả về duration dạng số thập phân (e.g. 14.101312 giây)
 *
 * Run: node scripts/migrate-duration-to-double.mjs
 */

import 'dotenv/config'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

async function migrate() {
  console.log('🚀 Migrating duration column: INTEGER → DOUBLE PRECISION...')

  try {
    await sql`
      ALTER TABLE attachments
      ALTER COLUMN duration TYPE double precision
      USING duration::double precision
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
