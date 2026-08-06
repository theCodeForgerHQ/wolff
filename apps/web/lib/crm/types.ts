export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'disqualified' | 'converted';
export type LeadSource = 'manual' | 'widget' | 'api' | 'import';

export interface LeadListItem {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: LeadSource;
  status: LeadStatus;
  score: number | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadDetail extends LeadListItem {
  message: string | null;
}

export interface LeadFilter {
  search?: string;
  status?: LeadStatus;
  source?: LeadSource;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'company' | 'status' | 'score' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedLeads {
  data: LeadListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CreateLeadInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  source?: LeadSource;
  status?: LeadStatus;
  score?: number | null;
  message?: string | null;
  ownerId?: string | null;
}

export interface UpdateLeadInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  source?: LeadSource;
  status?: LeadStatus;
  score?: number | null;
  message?: string | null;
  ownerId?: string | null;
}

export interface ConvertLeadInput {
  title?: string;
  value?: number;
  currency?: string;
  stageId?: string;
}

export interface ConvertLeadResult {
  clientId: string;
  dealId: string;
  leadId: string;
}
