import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { Session } from '@prisma/client';
import { Address } from '@multiversx/sdk-core';
import { UserVerifier } from '@multiversx/sdk-wallet';
import { keccak_256 } from '@noble/hashes/sha3';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private prisma: PrismaService) {}

  async createSession(data: {
    channelId: string;
    employer: string;
    receiver: string;
    tokenId: string;
    amountLocked: string;
  }): Promise<Session> {
    this.logger.log(`Creating session: ${data.channelId}`);
    return this.prisma.session.create({
      data: {
        ...data,
        status: 'OPEN',
      },
    });
  }

  async getSession(channelId: string): Promise<Session> {
    const session = await this.prisma.session.findUnique({
      where: { channelId },
    });
    if (!session) {
      throw new NotFoundException(`Session ${channelId} not found`);
    }
    return session;
  }

  async addVoucher(
    channelId: string,
    data: {
      amount: string;
      nonce: number;
      signature: string;
    },
  ): Promise<Session> {
    const session = await this.getSession(channelId);

    if (session.status !== 'OPEN') {
      throw new BadRequestException(`Session ${channelId} is not OPEN`);
    }

    // Basic cumulative check
    const currentAmount = BigInt(session.lastVoucherAmount);
    const newAmount = BigInt(data.amount);

    if (
      newAmount <= currentAmount &&
      BigInt(data.nonce) <= session.lastVoucherNonce
    ) {
      throw new BadRequestException(
        'Voucher must be cumulative or have a higher nonce than the previous one',
      );
    }

    // signature verification
    const isValid = this.verifyVoucher({
      employer: session.employer,
      channelId: session.channelId,
      amount: data.amount,
      nonce: data.nonce,
      signature: data.signature,
    });

    if (!(await isValid)) {
      throw new BadRequestException('Invalid voucher signature');
    }

    this.logger.log(
      `Updating session ${channelId} with verified voucher: amount=${data.amount}, nonce=${data.nonce}`,
    );

    return this.prisma.session.update({
      where: { channelId },
      data: {
        lastVoucherAmount: data.amount,
        lastVoucherNonce: BigInt(data.nonce),
        lastVoucherSignature: data.signature,
      },
    });
  }

  async updateStatus(channelId: string, status: string): Promise<Session> {
    return this.prisma.session.update({
      where: { channelId },
      data: { status },
    });
  }

  async listActiveSessions(): Promise<Session[]> {
    return this.prisma.session.findMany({
      where: {
        status: 'OPEN',
      },
    });
  }

  private verifyVoucher(data: {
    employer: string;
    channelId: string;
    amount: string;
    nonce: number;
    signature: string;
  }): Promise<boolean> {
    const contractAddr = process.env.MPP_SESSION_CONTRACT || '';
    if (!contractAddr) {
      this.logger.warn(
        'MPP_SESSION_CONTRACT not set, skipping signature verification',
      );
      return Promise.resolve(true);
    }

    try {
      const employer = Address.newFromBech32(data.employer);
      const contract = Address.newFromBech32(contractAddr);

      // Amount as 32 bytes big endian (canonical)
      const amountBuf = Buffer.alloc(32);
      const amountHex = BigInt(data.amount).toString(16).padStart(64, '0');
      amountBuf.write(amountHex, 'hex');

      // Nonce as 8 bytes big endian
      const nonceBuf = Buffer.alloc(8);
      nonceBuf.writeBigUInt64BE(BigInt(data.nonce));

      const messageToHash = Buffer.concat([
        Buffer.from('mpp-session-v1'),
        Buffer.from(contract.getPublicKey()),
        Buffer.from(data.channelId, 'hex'),
        amountBuf,
        nonceBuf,
      ]);

      const hash = keccak_256(messageToHash);
      const verifier = UserVerifier.fromAddress({
        pubkey: () => Buffer.from(employer.getPublicKey()),
      });

      return verifier.verify(hash, Buffer.from(data.signature, 'hex'));
    } catch (err) {
      this.logger.error(`Voucher verification failed: ${err}`);
      return Promise.resolve(false);
    }
  }
}
