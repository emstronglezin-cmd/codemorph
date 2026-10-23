// Shared API response types.
// PHASE 49 - ce fichier ne contient plus la ligne "export * from './index'" :
// un barrel qui se re-exporte lui-meme est un cycle sterile. Les modeles
// generes sont re-exportes par src/types/index.ts, ecrit dynamiquement.

export interface ApiResponse<T> {
  data:    T;
  message: string;
  success: boolean;
}

export interface PaginatedResponse<T> {
  items:   T[];
  total:   number;
  page:    number;
  perPage: number;
}
