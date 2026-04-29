import type Database from 'better-sqlite3'
import type {
  VectorCollectionOptions,
  VectorCollectionState,
  VectorSearchHit,
  VectorSearchOptions,
  VectorStore,
  VectorUpsertItem
} from './vectorStore'

type SqliteVecModule = {
  load: (database: Database.Database) => void
  getLoadablePath?: () => string
}

function resolveLoadableExtensionPath(loadablePath: string): string {
  return loadablePath.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
}

export class SqliteVec0VectorStore implements VectorStore {
  name = 'sqlite_vec0'

  private available = false
  private error = ''

  load(db: Database.Database): void {
    try {
      const sqliteVec = require('sqlite-vec') as SqliteVecModule
      const loadablePath = sqliteVec.getLoadablePath?.()
      if (loadablePath) {
        db.loadExtension(resolveLoadableExtensionPath(loadablePath))
      } else {
        sqliteVec.load(db)
      }
      this.available = true
      this.error = ''
    } catch (error) {
      this.available = false
      this.error = String(error)
      console.warn('[VectorStore:sqlite_vec0] sqlite-vec 加载失败，语义向量检索将降级为关键词检索:', error)
    }
  }

  isAvailable(): boolean {
    return this.available
  }

  getError(): string {
    return this.error
  }

  ensureCollection(db: Database.Database, options: VectorCollectionOptions): VectorCollectionState {
    if (!this.available) return { recreated: false }

    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    const desiredDim = Math.max(1, Math.floor(Number(options.dim) || 0))
    const tableRow = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'message_embedding_vec'
    `).get() as { sql?: string } | undefined
    const existingDim = tableRow?.sql
      ? Number(String(tableRow.sql).match(/embedding\s+FLOAT\[(\d+)\]/i)?.[1] || 0)
      : 0
    const metaRow = db.prepare('SELECT value FROM vector_store_meta WHERE key = ?').get('message_embedding_vec_dim') as { value?: string } | undefined
    const metaDim = Number(metaRow?.value || 0)
    const hasDimensionMismatch = !!tableRow && (
      (Number.isInteger(existingDim) && existingDim > 0 && existingDim !== desiredDim)
      || (Number.isInteger(metaDim) && metaDim > 0 && metaDim !== desiredDim)
    )
    let recreated = false

    if (hasDimensionMismatch) {
      db.exec('DROP TABLE IF EXISTS message_embedding_vec;')
      recreated = true
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_embedding_vec USING vec0(
        vector_id INTEGER PRIMARY KEY,
        session_key INTEGER PARTITION KEY,
        session_id TEXT,
        vector_model TEXT,
        embedding FLOAT[${desiredDim}] distance_metric=cosine
      );
    `)

    db.prepare('INSERT OR REPLACE INTO vector_store_meta(key, value) VALUES (?, ?)').run('message_embedding_vec_dim', String(desiredDim))
    return { recreated }
  }

  upsert(db: Database.Database, item: VectorUpsertItem): void {
    this.assertAvailable()
    db.prepare(`
      INSERT OR REPLACE INTO message_embedding_vec(vector_id, session_key, session_id, vector_model, embedding)
      VALUES (CAST(? AS INTEGER), CAST(? AS INTEGER), ?, ?, ?)
    `).run(item.vectorId, item.sessionKey, item.sessionId, item.modelId, item.embedding)
  }

  deleteByVectorId(db: Database.Database, vectorId: number): void {
    if (!this.available) return
    db.prepare('DELETE FROM message_embedding_vec WHERE vector_id = ?').run(vectorId)
  }

  deleteByVectorIds(db: Database.Database, vectorIds: number[]): void {
    if (!this.available || vectorIds.length === 0) return

    const deleteVector = db.prepare('DELETE FROM message_embedding_vec WHERE vector_id = ?')
    const run = db.transaction((ids: number[]) => {
      for (const id of ids) {
        deleteVector.run(id)
      }
    })
    run(vectorIds)
  }

  clearModel(db: Database.Database, modelId: string): void {
    if (!this.available) return
    db.prepare('DELETE FROM message_embedding_vec WHERE vector_model = ?').run(modelId)
  }

  search(db: Database.Database, options: VectorSearchOptions): VectorSearchHit[] {
    this.assertAvailable()
    const rows = db.prepare(`
      SELECT vector_id, distance
      FROM message_embedding_vec
      WHERE embedding MATCH @queryEmbedding
        AND session_key = CAST(@sessionKey AS INTEGER)
        AND k = @limit
      ORDER BY distance ASC
    `).all({
      queryEmbedding: options.queryEmbedding,
      sessionKey: options.sessionKey,
      limit: options.limit
    }) as Array<{ vector_id: number; distance: number }>

    return rows.map((row) => ({
      vectorId: Number(row.vector_id || 0),
      distance: Number(row.distance || 0)
    }))
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new Error(`本地语义检索不可用：${this.error || 'sqlite-vec 未加载'}`)
    }
  }
}
