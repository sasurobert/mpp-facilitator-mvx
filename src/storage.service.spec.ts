import { StorageService, SettlementRecord } from './storage.service';
import { PrismaService } from './prisma.service';

process.env.DATABASE_URL ||= 'file:./dev.db';

describe('StorageService', () => {
  let service: StorageService;
  let prisma: PrismaService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.settlementRecord.deleteMany();
    service = new StorageService(prisma);
  });

  it('should save and retrieve a record', async () => {
    const record: SettlementRecord = {
      id: 'challenge-1',
      txHash: '',
      payer: 'erd1sender',
      receiver: 'erd1receiver',
      amount: '1000000000000000000',
      currency: 'EGLD',
      chainId: 'D',
      status: 'pending',
      createdAt: new Date(),
      expiresAt: null,
    };

    await service.save(record);
    const result = await service.get('challenge-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('challenge-1');
    expect(result!.receiver).toBe('erd1receiver');
    expect(result!.currency).toBe('EGLD');
    expect(result!.chainId).toBe('D');
  });

  it('should return null for non-existent records', async () => {
    const result = await service.get('nonexistent');
    expect(result).toBeNull();
  });

  it('should update status and txHash', async () => {
    const record: SettlementRecord = {
      id: 'challenge-2',
      txHash: '',
      payer: 'erd1sender',
      receiver: 'erd1receiver',
      amount: '500',
      currency: 'USDC-c76f31',
      chainId: '1',
      status: 'pending',
      createdAt: new Date(),
      expiresAt: null,
    };

    await service.save(record);
    await service.updateStatus('challenge-2', 'completed', '0xabc123');

    const result = await service.get('challenge-2');
    expect(result!.status).toBe('completed');
    expect(result!.txHash).toBe('0xabc123');
  });

  it('should preserve all fields after status update', async () => {
    const record: SettlementRecord = {
      id: 'challenge-3',
      txHash: '',
      payer: 'erd1payer',
      receiver: 'erd1recv',
      amount: '999',
      currency: 'WEGLD-bd4d79',
      chainId: 'T',
      status: 'pending',
      createdAt: new Date(12345),
      expiresAt: new Date('2026-12-31T00:00:00Z'),
    };

    await service.save(record);
    await service.updateStatus('challenge-3', 'completed');

    const result = await service.get('challenge-3');
    expect(result!.receiver).toBe('erd1recv');
    expect(result!.currency).toBe('WEGLD-bd4d79');
    expect(result!.amount).toBe('999');
    expect(result!.expiresAt).toEqual(new Date('2026-12-31T00:00:00Z'));
  });

  it('should purge expired pending records', async () => {
    const past = new Date(Date.now() - 60000).toISOString(); // 1 min ago
    const future = new Date(Date.now() + 60000).toISOString(); // 1 min from now

    await service.save({
      id: 'expired',
      txHash: '',
      payer: 'erd1',
      receiver: 'erd2',
      amount: '100',
      currency: 'EGLD',
      chainId: 'D',
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(past),
    });

    await service.save({
      id: 'still-valid',
      txHash: '',
      payer: 'erd1',
      receiver: 'erd2',
      amount: '100',
      currency: 'EGLD',
      chainId: 'D',
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(future),
    });

    await service.save({
      id: 'completed-expired',
      txHash: '0xdone',
      payer: 'erd1',
      receiver: 'erd2',
      amount: '100',
      currency: 'EGLD',
      chainId: 'D',
      status: 'completed',
      createdAt: new Date(),
      expiresAt: new Date(past), // expired but already completed
    });

    const purged = await service.purgeExpired();
    expect(purged).toBe(1); // only "expired" should be purged

    expect(await service.get('expired')).toBeNull();
    expect(await service.get('still-valid')).not.toBeNull();
    expect(await service.get('completed-expired')).not.toBeNull(); // not purged because completed
  });

  it('should return correct count', async () => {
    expect(await service.count()).toBe(0);

    await service.save({
      id: 'a',
      txHash: '',
      payer: '',
      receiver: '',
      amount: '0',
      currency: 'EGLD',
      chainId: 'D',
      status: 'pending',
      createdAt: new Date(0),
      expiresAt: null,
    });

    expect(await service.count()).toBe(1);
  });
});
