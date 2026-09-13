export type SourceKind = "api" | "ckan" | "csv" | "xlsx" | "json" | "xml" | "geo" | "html" | "pdf" | "zip" | "txt" | "dta" | "sav" | "manual";
export type AuthKind = "none" | "token" | "account" | "legal-identity" | "unknown";

export interface SourceDefinition {
  id: string;
  name: string;
  institution: string;
  domain: string;
  description: string;
  baseUrl: string;
  kinds: SourceKind[];
  auth: AuthKind;
  automatic: boolean;
  territorialLevels: string[];
  notes?: string;
}

export interface NormalizedTransaction {
  sourceId: string;
  externalId: string;
  transactionType: string;
  occurredAt?: string | null;
  publishedAt?: string | null;
  amount?: number | null;
  currency?: string | null;
  title?: string | null;
  description?: string | null;
  category?: string | null;
  subcategory?: string | null;
  projectExternalId?: string | null;
  geoCode?: string | null;
  geoName?: string | null;
  rawSnapshotId?: number | null;
  payload: unknown;
  parties?: Array<{
    role: string;
    externalId?: string | null;
    name: string;
    rut?: string | null;
    partyType?: string | null;
  }>;
}
