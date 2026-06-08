export type AssetType =
  | 'real_estate' | 'commodity' | 'security'
  | 'art' | 'fund' | 'bond' | 'digital';

export type AssetStatus = 'draft' | 'active' | 'suspended' | 'retired';

export type TokenStandard = 'ERC-20' | 'ERC-721';

export type TokenStatus = 'draft' | 'active' | 'paused' | 'retired';

export type HolderStatus = 'active' | 'frozen' | 'removed';

export type KycStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type OperationType =
  | 'mint' | 'burn' | 'freeze' | 'unfreeze'
  | 'transfer' | 'force_transfer';

export type RestrictionType =
  | 'whitelist' | 'jurisdiction_block' | 'lockup'
  | 'max_holders' | 'min_holding' | 'max_holding';

export type CorporateActionType =
  | 'dividend' | 'interest_payment' | 'vote' | 'stock_split';

export type CorporateActionStatus =
  | 'draft' | 'announced' | 'record_set'
  | 'processing' | 'completed' | 'cancelled';

export interface CreateAssetRequest {
  externalId: string;
  assetType: AssetType;
  name: string;
  description?: string;
  issuerId: string;
  valuation?: bigint;
  valuationCurrency?: string;
  jurisdiction?: string;
  legalDocRefs?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateTokenRequest {
  assetId?: string;
  symbol: string;
  name: string;
  tokenStandard: TokenStandard;
  decimals?: number;
  maxSupply?: bigint;
  contractAddress?: string;
  chain?: string;
  treasuryCurrency: string;
  metadata?: Record<string, unknown>;
}

export interface MintRequest {
  tokenId: string;
  toAccountId: string;
  amount: bigint;
  holderAddress?: string;
  operatorId?: string;
  reason?: string;
  idempotencyKey: string;
}

export interface BurnRequest {
  tokenId: string;
  fromAccountId: string;
  amount: bigint;
  operatorId?: string;
  reason?: string;
  idempotencyKey: string;
}

export interface TransferRequest {
  tokenId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: bigint;
  operatorId?: string;
  reason?: string;
  idempotencyKey: string;
}

export interface FreezeHolderRequest {
  tokenId: string;
  accountId: string;
  operatorId?: string;
  reason?: string;
}

export interface AddRestrictionRequest {
  tokenId: string;
  restrictionType: RestrictionType;
  config: Record<string, unknown>;
}

export interface WhitelistAddressRequest {
  tokenId: string;
  address: string;
  validFrom?: Date;
  validUntil?: Date;
}

export interface CreateCorporateActionRequest {
  tokenId: string;
  actionType: CorporateActionType;
  title: string;
  description?: string;
  perTokenAmount?: bigint;
  voteOptions?: string[];
  metadata?: Record<string, unknown>;
}

export interface CastVoteRequest {
  actionId: string;
  accountId: string;
  voteChoice: string;
}

export interface ComplianceCheckResult {
  allowed: boolean;
  violations: ComplianceViolation[];
}

export interface ComplianceViolation {
  restrictionType: RestrictionType;
  restrictionId: string;
  message: string;
}
