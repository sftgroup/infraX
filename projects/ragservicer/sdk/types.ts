/**
 * InfraX RAGservicer Client SDK — Type Definitions
 */

export interface RagServicerConfig {
  baseUrl: string;
  apiKey?: string;
  tenantId?: string;
  timeout?: number;
}

/** @deprecated Use RagServicerConfig instead */
export type DocConfig = RagServicerConfig;
/** @deprecated Use RagServicerConfig instead */
export type LightRAGConfig = RagServicerConfig;

export interface InsertResult {
  success: boolean;
  doc_id: string;
  tenant: string;
  namespace: string;
}

export interface QueryResult {
  context: string;
  mode: string;
  tenant: string;
  namespace: string;
}

export interface RetrieveChunk {
  content: string;
  score: number;
  doc_id: string;
  chunk_id: string;
}

export interface RetrieveResult {
  chunks: RetrieveChunk[];
  mode: string;
  query: string;
}

export interface DocumentInfo {
  doc_id: string;
  size_bytes: number;
  chunk_count: number;
  created_at: string;
  status: 'indexed' | 'indexing' | 'error';
}

export interface TenantInfo {
  tenant_id: string;
  name: string;
  description: string;
}

export interface ApiKeyInfo {
  key_id: string;
  tenant_id: string;
  name: string;
  key: string;
  key_prefix: string;
  created_at: string;
  expires_at?: string;
}

export class RagServicerError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'RagServicerError';
  }
}

/** @deprecated Use RagServicerError instead */
export const DocError = RagServicerError;
/** @deprecated Use RagServicerError instead */
export const LightRAGError = RagServicerError;
