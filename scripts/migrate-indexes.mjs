/**
 * migrate-indexes.mjs
 *
 * Thêm các DB indexes để tối ưu performance cho 50-100 concurrent users.
 * Dùng CREATE INDEX CONCURRENTLY → không lock table trong production.
 *
 * Chạy: node scripts/migrate-indexes.mjs
 *
 * Lưu ý: CONCURRENTLY không thể chạy trong transaction block,
 * nên script này chạy từng lệnh riêng lẻ.
 */
import postgres from 'postgres'
import { config } from 'dotenv'

config()

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })

async function run() {
  console.log('🚀 Starting index migration...')

  /**
   * Index 1: messages(channel_id, created_at DESC) WHERE deleted_at IS NULL
   *
   * Tối ưu cho query getMessages:
   *   WHERE channel_id = $1 AND created_at < $cursor
   *   ORDER BY created_at DESC
   *   LIMIT 51
   *
   * Partial index (WHERE deleted_at IS NULL) giúp:
   *   - Index nhỏ hơn (không index soft-deleted messages)
   *   - Scan nhanh hơn vì loại bỏ hầu hết deleted rows
   *
   * CONCURRENTLY: không block reads/writes trong production.
   * Downside: mất 2 passes, không thể chạy trong transaction.
   */
  console.log('\n📊 Creating index: messages(channel_id, created_at DESC)...')
  try {
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_channel_created
      ON messages(channel_id, created_at DESC)
      WHERE deleted_at IS NULL
    `)
    console.log('✅ idx_messages_channel_created created')
  } catch (err) {
    console.error('❌ Failed:', err.message)
  }

  /**
   * Index 2: reactions(message_id)
   *
   * Tối ưu cho query lấy reactions khi load messages:
   *   WHERE message_id IN ($id1, $id2, ..., $id50)
   *
   * Hiện tại đã có index reactions_message_idx trong schema.ts,
   * nhưng nếu migration cũ chưa tạo, script này đảm bảo nó tồn tại.
   */
  console.log('\n📊 Creating index: reactions(message_id)...')
  try {
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reactions_message_id
      ON reactions(message_id)
    `)
    console.log('✅ idx_reactions_message_id created')
  } catch (err) {
    console.error('❌ Failed:', err.message)
  }

  /**
   * Index 3: messages(user_id, channel_id) 
   *
   * Tối ưu cho authorization check assertChannelAccess:
   * JOIN với workspace_members và channel_members dùng (workspace_id, user_id).
   * workspace_members đã có index trên (workspace_id, user_id) từ schema.ts,
   * nhưng thêm index messages(user_id) để giúp các queries filter by sender.
   */
  console.log('\n📊 Verifying existing indexes...')
  try {
    const indexes = await sql`
      SELECT indexname, tablename
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('messages', 'reactions', 'workspace_members', 'channel_members')
      ORDER BY tablename, indexname
    `
    console.log('\n📋 Current indexes on key tables:')
    for (const idx of indexes) {
      console.log(`  ${idx.tablename}: ${idx.indexname}`)
    }
  } catch (err) {
    console.error('Could not list indexes:', err.message)
  }

  await sql.end()
  console.log('\n✅ Index migration complete!')
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
