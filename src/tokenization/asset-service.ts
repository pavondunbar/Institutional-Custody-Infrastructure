import { db } from '../database/connection';
import { logger } from '../config';
import { CreateAssetRequest, AssetStatus } from './types';

export class AssetService {
  async createAsset(req: CreateAssetRequest): Promise<string> {
    const result = await db.query(
      `INSERT INTO assets (
        external_id, asset_type, name, description, issuer_id,
        valuation, valuation_currency, jurisdiction,
        legal_doc_refs, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id`,
      [
        req.externalId, req.assetType, req.name,
        req.description || null, req.issuerId,
        req.valuation?.toString() || null,
        req.valuationCurrency || null,
        req.jurisdiction || null,
        JSON.stringify(req.legalDocRefs || []),
        JSON.stringify(req.metadata || {}),
      ]
    );

    const assetId = result.rows[0].id;

    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('asset', $1, 'asset.created', $2)`,
      [assetId, JSON.stringify({
        assetId,
        externalId: req.externalId,
        assetType: req.assetType,
        name: req.name,
      })]
    );

    logger.info({ assetId, externalId: req.externalId }, 'Asset created');
    return assetId;
  }

  async getAsset(assetId: string) {
    const result = await db.query(
      'SELECT * FROM assets WHERE id = $1', [assetId]
    );
    return result.rows[0] || null;
  }

  async listAssets(filters: {
    assetType?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const limit = Math.min(filters.limit || 50, 200);
    const offset = filters.offset || 0;
    let query = 'SELECT * FROM assets WHERE 1=1';
    const params: unknown[] = [];

    if (filters.assetType) {
      params.push(filters.assetType);
      query += ` AND asset_type = $${params.length}`;
    }
    if (filters.status) {
      params.push(filters.status);
      query += ` AND status = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return { assets: result.rows, limit, offset };
  }

  async updateValuation(
    assetId: string,
    valuation: bigint,
    currency: string,
  ): Promise<void> {
    const result = await db.query(
      `UPDATE assets
       SET valuation = $1, valuation_currency = $2, updated_at = NOW()
       WHERE id = $3 AND status != 'retired'
       RETURNING id`,
      [valuation.toString(), currency, assetId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Asset ${assetId} not found or retired`);
    }

    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('asset', $1, 'asset.valuation_updated', $2)`,
      [assetId, JSON.stringify({
        assetId,
        valuation: valuation.toString(),
        currency,
      })]
    );
  }

  async updateStatus(
    assetId: string,
    newStatus: AssetStatus,
    eventType: string,
  ): Promise<void> {
    const result = await db.query(
      `UPDATE assets SET status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id`,
      [newStatus, assetId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Asset ${assetId} not found`);
    }

    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('asset', $1, $2, $3)`,
      [assetId, eventType, JSON.stringify({ assetId, status: newStatus })]
    );

    logger.info({ assetId, status: newStatus }, 'Asset status updated');
  }

  async activateAsset(assetId: string): Promise<void> {
    await this.updateStatus(assetId, 'active', 'asset.activated');
  }

  async suspendAsset(assetId: string): Promise<void> {
    await this.updateStatus(assetId, 'suspended', 'asset.suspended');
  }
}
