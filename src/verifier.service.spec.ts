import { VerifierService } from './verifier.service';
import { StorageService, SettlementRecord } from './storage.service';
import { PrismaService } from './prisma.service';
import { Address } from '@multiversx/sdk-core';

process.env.DATABASE_URL ||= 'file:./dev.db';

// Mock the ApiNetworkProvider
jest.mock('@multiversx/sdk-network-providers', () => ({
  ApiNetworkProvider: jest.fn().mockImplementation(() => ({
    getTransaction: jest.fn(),
  })),
}));

describe('VerifierService', () => {
  let service: VerifierService;
  let storageService: StorageService;
  let prisma: PrismaService;
  let mockGetTransaction: jest.Mock;
  let challengeCounter = 0;

  function makeRecord(overrides?: Partial<SettlementRecord>): SettlementRecord {
    challengeCounter++;
    return {
      id: `challenge-${challengeCounter}`,
      txHash: '',
      payer: 'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      receiver:
        'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      amount: '1000000000000000000',
      currency: 'EGLD',
      chainId: 'D',
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
      opaque: null,
      digest: null,
      source: null,
      ...overrides,
    };
  }

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.settlementRecord.deleteMany();
    storageService = new StorageService(prisma);
    service = new VerifierService(storageService);

    // Access the mocked provider
    mockGetTransaction = (
      service as unknown as { provider: { getTransaction: jest.Mock } }
    ).provider.getTransaction;
  });

  it('should return error for non-existent challenge', async () => {
    const result = await service.verifyTransaction(
      '0xaaa',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      'nonexistent-xyz',
      '1000',
      'EGLD',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Challenge not found');
  });

  it('should return idempotent success for already-completed challenge', async () => {
    const rec = makeRecord({ status: 'completed', txHash: '0x123' });
    await storageService.save(rec);

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000',
      'EGLD',
    );
    expect(result.success).toBe(true);
  });

  it('should reject different txHash for already-completed challenge', async () => {
    const rec = makeRecord({ status: 'completed', txHash: '0x123' });
    await storageService.save(rec);

    const result = await service.verifyTransaction(
      '0xdifferent',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000',
      'EGLD',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('already settled');
  });

  it('should reject expired challenges', async () => {
    const rec = makeRecord({
      expiresAt: new Date(Date.now() - 60000),
    });
    await storageService.save(rec);

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000',
      'EGLD',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('should reject when transaction not found on network', async () => {
    const rec = makeRecord();
    await storageService.save(rec);
    mockGetTransaction.mockRejectedValue(new Error('Not found'));

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000',
      'EGLD',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found on the network');
  });

  it('should reject failed transactions', async () => {
    const rec = makeRecord();
    await storageService.save(rec);
    mockGetTransaction.mockResolvedValue({
      status: {
        isSuccessful: () => false,
        isFailed: () => true,
        isPending: () => false,
        isInvalid: () => false,
      },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: '1000000000000000000',
      data: Buffer.from(`mpp:${rec.id}`),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000000000000000000',
      'EGLD',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('failed');
  });

  it('should reject sender mismatch', async () => {
    const rec = makeRecord();
    await storageService.save(rec);
    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: '1000000000000000000',
      data: Buffer.from(`mpp:${rec.id}`),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000000000000000000',
      'EGLD',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('sender does not match');
  });

  it('should reject EGLD amount mismatch', async () => {
    const rec = makeRecord();
    await storageService.save(rec);
    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: '500000000000000000',
      data: Buffer.from(`mpp:${rec.id}`),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000000000000000000',
      'EGLD',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Amount mismatch');
  });

  it('should reject receiver mismatch for EGLD', async () => {
    const rec = makeRecord();
    await storageService.save(rec);
    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      value: { toString: () => '1000000000000000000' },
      data: Buffer.from(`mpp:${rec.id}`),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000000000000000000',
      'EGLD',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Receiver does not match');
  });

  it('should verify successfully for valid EGLD transaction', async () => {
    const rec = makeRecord();
    await storageService.save(rec);
    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: { toString: () => '1000000000000000000' },
      data: Buffer.from(`mpp:${rec.id}`),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000000000000000000',
      'EGLD',
    );
    expect(result.success).toBe(true);

    // Verify record was marked completed
    const record = await storageService.get(rec.id);
    expect(record!.status).toBe('completed');
    expect(record!.txHash).toBe('0x123');
  });

  it('should reject data payload without challenge ID', async () => {
    const rec = makeRecord();
    await storageService.save(rec);
    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: { toString: () => '1000000000000000000' },
      data: Buffer.from('some random data without any id'),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000000000000000000',
      'EGLD',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('challenge ID tag');
  });

  it('should detect ESDT transfer and reject non-ESDT data for ESDT currency', async () => {
    const rec = makeRecord({ currency: 'USDC-c76f31', amount: '50000000' });
    await storageService.save(rec);

    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: '0',
      data: Buffer.from(`mpp:${rec.id}`), // no ESDTTransfer prefix
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '50000000',
      'USDC-c76f31',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Expected ESDT transfer');
  });

  it('should verify successfully for valid ESDTTransfer', async () => {
    const rec = makeRecord({ currency: 'USDC-c76f31', amount: '50000000' });
    await storageService.save(rec);

    const tokenHex = Buffer.from('USDC-c76f31').toString('hex');
    let amountHex = BigInt(rec.amount).toString(16);
    if (amountHex.length % 2 !== 0) amountHex = '0' + amountHex;
    const data = `ESDTTransfer@${tokenHex}@${amountHex}@${Buffer.from(`mpp:${rec.id}`).toString('hex')}`;

    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () => rec.receiver,
      },
      value: '0',
      data: Buffer.from(data),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '50000000',
      'USDC-c76f31',
    );
    expect(result.success).toBe(true);
  });

  it('should verify successfully for valid MultiTransferESDT alias', async () => {
    const rec = makeRecord({ currency: 'USDC-c76f31', amount: '50000000' });
    await storageService.save(rec);

    // MultiTransferESDT@<receiverHex>@<numTransfers>@<token1Hex>@<amount1Hex>
    const receiverHex = new Address(rec.receiver).toHex();
    const tokenHex = Buffer.from('USDC-c76f31').toString('hex');
    const amountHex = BigInt(rec.amount).toString(16);
    const data = `MultiTransferESDT@${receiverHex}@01@${tokenHex}@${amountHex}@${Buffer.from(`mpp:${rec.id}`).toString('hex')}`;

    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: '0',
      data: Buffer.from(data),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '50000000',
      'USDC-c76f31',
    );
    expect(result.success).toBe(true);
  });

  it('should reject when opaque mismatch', async () => {
    const rec = makeRecord({ opaque: JSON.stringify({ data: 'secret123' }) });
    await storageService.save(rec);

    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: '1000000000000000000',
      data: Buffer.from(`mpp:${rec.id}`),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000000000000000000',
      'EGLD',
      undefined,
      { data: 'wrong-opaque' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Opaque mismatch');
  });

  it('should verify successfully when opaque matches', async () => {
    const rec = makeRecord({ opaque: JSON.stringify({ data: 'secret123' }) });
    await storageService.save(rec);

    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: '1000000000000000000',
      data: Buffer.from(`mpp:${rec.id}`),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000000000000000000',
      'EGLD',
      undefined,
      { data: 'secret123' },
    );
    expect(result.success).toBe(true);
  });

  it('should reject when digest mismatch', async () => {
    const rec = makeRecord({ digest: 'sha256-correct' });
    await storageService.save(rec);

    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: '1000000000000000000',
      data: Buffer.from(`mpp:${rec.id}`),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000000000000000000',
      'EGLD',
      undefined,
      undefined,
      'sha256-wrong',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Digest mismatch');
  });

  it('should verify successfully for valid MultiESDTNFTTransfer with multiple tokens', async () => {
    const rec = makeRecord({ currency: 'TOKEN-123456', amount: '1000' });
    await storageService.save(rec);

    // MultiESDTNFTTransfer@<receiverHex>@<numTransfers>@<token1Hex>@<nonce1Hex>@<amount1Hex>@<token2Hex>@<nonce2Hex>@<amount2Hex>
    const receiverHex = new Address(rec.receiver).toHex();
    const token1Hex = Buffer.from('OTHER-999999').toString('hex');
    const token2Hex = Buffer.from('TOKEN-123456').toString('hex');
    const nonceHex = '00';
    const amount1Hex = '05'; // 5
    const amount2Hex = BigInt('1000').toString(16);

    const data = `MultiESDTNFTTransfer@${receiverHex}@02@${token1Hex}@${nonceHex}@${amount1Hex}@${token2Hex}@${nonceHex}@${amount2Hex}@${Buffer.from(`mpp:${rec.id}`).toString('hex')}`;

    mockGetTransaction.mockResolvedValue({
      status: { isSuccessful: () => true },
      sender: {
        toBech32: () =>
          'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      },
      receiver: {
        toBech32: () =>
          'erd1sea63y47u569ns3x5mqjf4vnygn9whkk7p6ry4rfpqyd6rd5addqyd9lf2',
      },
      value: '0',
      data: Buffer.from(data),
    });

    const result = await service.verifyTransaction(
      '0x123',
      'erd1qyu5wthld6uqvlv7h243upv9qmfh4u2daer09ry3nclpyv76y7xs36h90r',
      rec.id,
      '1000',
      'TOKEN-123456',
    );
    expect(result.success).toBe(true);
  });
});
