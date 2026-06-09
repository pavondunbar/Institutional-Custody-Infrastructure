import { db, withSerializableTransaction } from '../database/connection';
import { logger } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type ColdStorageTransferStatus = 'pending_approval' | 'approved' | 'signing' | 'broadcasting' | 'confirmed' | 'rejected';

export interface MultiSigPolicy {
  id: string;
  name: string;
  requiredSignatures: number;
  totalSigners: number;
  signerIds: string[];
  appliesToWalletTypes: string[];
  minAmount: string;
  maxAmount: string | null;
  cooldownMinutes: number;
}

export interface WithdrawalWhitelistEntry {
  id: string;
  walletId: string;
  address: string;
  label: string;
  addedBy: string;
  approvedBy: string | null;
  status: 'pending' | 'active' | 'revoked';
  createdAt: Date;
}

export interface ColdStorageTransfer {
  id: string;
  sourceWalletId: string;
  destinationAddress: string;
  asset: string;
  amount: string;
  policyId: string;
  status: ColdStorageTransferStatus;
  signatures: { signerId: string; signedAt: Date }[];
  requiredSignatures: number;
  initiatedBy: string;
}

export class CryptoCustodyService {
  async createMultiSigPolicy(params: {
    name: string;
    requiredSignatures: number;
    totalSigners: number;
    signerIds: string[];
    appliesToWalletTypes: string[];
    minAmount: string;
    maxAmount?: string;
    cooldownMinutes?: number;
  }): Promise<MultiSigPolicy> {
    const id = uuidv4();
    await db.query(
      `INSERT INTO multisig_policies (id, name, required_signatures, total_signers, signer_ids, applies_to_wallet_types, min_amount, max_amount, cooldown_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, params.name, params.requiredSignatures, params.totalSigners, JSON.stringify(params.signerIds), JSON.stringify(params.appliesToWalletTypes), params.minAmount, params.maxAmount || null, params.cooldownMinutes || 60]
    );
    logger.info({ id, name: params.name, m: params.requiredSignatures, n: params.totalSigners }, 'Multi-sig policy created');
    return { id, ...params, maxAmount: params.maxAmount || null, cooldownMinutes: params.cooldownMinutes || 60 };
  }

  async addToWhitelist(params: { walletId: string; address: string; label: string; addedBy: string }): Promise<WithdrawalWhitelistEntry> {
    const id = uuidv4();
    await db.query(
      `INSERT INTO withdrawal_whitelist (id, wallet_id, address, label, added_by, status) VALUES ($1,$2,$3,$4,$5,'pending')`,
      [id, params.walletId, params.address, params.label, params.addedBy]
    );
    logger.info({ id, address: params.address, walletId: params.walletId }, 'Whitelist entry pending approval');
    return { id, ...params, approvedBy: null, status: 'pending', createdAt: new Date() };
  }

  async approveWhitelistEntry(entryId: string, approvedBy: string): Promise<void> {
    const { rowCount } = await db.query(
      `UPDATE withdrawal_whitelist SET status='active', approved_by=$2 WHERE id=$1 AND status='pending'`,
      [entryId, approvedBy]
    );
    if (!rowCount) throw new Error('Whitelist entry not found or already processed');
  }

  async isAddressWhitelisted(walletId: string, address: string): Promise<boolean> {
    const { rows } = await db.query(
      `SELECT 1 FROM withdrawal_whitelist WHERE wallet_id=$1 AND address=$2 AND status='active'`,
      [walletId, address]
    );
    return rows.length > 0;
  }

  async initiateColdStorageTransfer(params: {
    sourceWalletId: string;
    destinationAddress: string;
    asset: string;
    amount: string;
    initiatedBy: string;
  }): Promise<ColdStorageTransfer> {
    // Check whitelist
    const whitelisted = await this.isAddressWhitelisted(params.sourceWalletId, params.destinationAddress);
    if (!whitelisted) throw new Error('Destination address not on withdrawal whitelist');

    // Find applicable policy
    const { rows: policies } = await db.query(
      `SELECT * FROM multisig_policies WHERE min_amount <= $1 AND (max_amount IS NULL OR max_amount >= $1) ORDER BY required_signatures DESC LIMIT 1`,
      [params.amount]
    );
    if (!policies.length) throw new Error('No applicable multi-sig policy found');
    const policy = policies[0];

    const id = uuidv4();
    await db.query(
      `INSERT INTO cold_storage_transfers (id, source_wallet_id, destination_address, asset, amount, policy_id, status, required_signatures, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6,'pending_approval',$7,$8)`,
      [id, params.sourceWalletId, params.destinationAddress, params.asset, params.amount, policy.id, policy.required_signatures, params.initiatedBy]
    );
    logger.info({ id, amount: params.amount, required: policy.required_signatures }, 'Cold storage transfer initiated');
    return { id, ...params, policyId: policy.id, status: 'pending_approval', signatures: [], requiredSignatures: policy.required_signatures };
  }

  async signColdStorageTransfer(transferId: string, signerId: string): Promise<{ status: ColdStorageTransferStatus; signaturesCollected: number }> {
    return await withSerializableTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM cold_storage_transfers WHERE id=$1 AND status='pending_approval' FOR UPDATE`, [transferId]
      );
      if (!rows.length) throw new Error('Transfer not found or not pending');
      const transfer = rows[0];

      // Verify signer is authorized
      const { rows: policyRows } = await client.query(`SELECT signer_ids FROM multisig_policies WHERE id=$1`, [transfer.policy_id]);
      const signerIds: string[] = JSON.parse(policyRows[0].signer_ids);
      if (!signerIds.includes(signerId)) throw new Error('Signer not authorized for this policy');

      // Check duplicate signature
      const existingSigs: { signerId: string; signedAt: Date }[] = JSON.parse(transfer.signatures || '[]');
      if (existingSigs.some(s => s.signerId === signerId)) throw new Error('Already signed');

      existingSigs.push({ signerId, signedAt: new Date() });
      const newStatus = existingSigs.length >= transfer.required_signatures ? 'approved' : 'pending_approval';

      await client.query(
        `UPDATE cold_storage_transfers SET signatures=$2, status=$3 WHERE id=$1`,
        [transferId, JSON.stringify(existingSigs), newStatus]
      );

      if (newStatus === 'approved') {
        await client.query(`INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('custody','${transferId}','cold_storage.approved','${JSON.stringify({ transferId })}')`);
      }
      return { status: newStatus, signaturesCollected: existingSigs.length };
    });
  }
}
