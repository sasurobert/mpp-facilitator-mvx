import { Injectable, Logger } from '@nestjs/common';
import {
  Address,
  Transaction,
  TransactionComputer,
} from '@multiversx/sdk-core';
import { UserSigner } from '@multiversx/sdk-wallet';
import { ProxyNetworkProvider } from '@multiversx/sdk-network-providers';
import * as fs from 'fs';
import * as path from 'path';

export class RelayedV3Payload {
  nonce!: number;
  value!: string;
  receiver!: string;
  sender!: string;
  relayer!: string;
  gasPrice!: number;
  gasLimit!: number;
  data?: string;
  chainID!: string;
  version!: number;
  options?: number;
  signature!: string;
}

@Injectable()
export class RelayerService {
  private readonly logger = new Logger(RelayerService.name);
  private signer?: UserSigner;
  private provider: ProxyNetworkProvider;
  private transactionComputer = new TransactionComputer();

  constructor() {
    const providerUrl =
      process.env.NETWORK_PROVIDER || 'https://devnet-gateway.multiversx.com';
    this.provider = new ProxyNetworkProvider(providerUrl);
    const pemPathEnv = process.env.RELAYER_PEM_PATH;
    if (!pemPathEnv) {
      this.logger.warn(
        'RELAYER_PEM_PATH is not set. Relayed V3 transactions will fail.',
      );
      return;
    }

    const pemPath = path.resolve(pemPathEnv);
    if (fs.existsSync(pemPath)) {
      try {
        const pemContent = fs.readFileSync(pemPath, 'utf8');
        this.signer = UserSigner.fromPem(pemContent);
        this.logger.log(
          `Loaded relayer wallet: ${this.signer.getAddress().bech32()}`,
        );
      } catch (e) {
        this.logger.error(`Failed to load PEM: ${e}`);
      }
    } else {
      this.logger.warn(
        `No relayer PEM found at ${pemPath}. Relayed V3 transactions will fail.`,
      );
    }
  }

  getRelayerAddress(): string | undefined {
    return this.signer?.getAddress().bech32();
  }

  setSignerFromPem(pemContent: string) {
    this.signer = UserSigner.fromPem(pemContent);
    this.logger.log(
      `Updated relayer wallet to: ${this.signer.getAddress().bech32()}`,
    );
  }

  async submitRelayedV3(payload: RelayedV3Payload): Promise<string> {
    if (!this.signer) {
      throw new Error('Relayer is not configured.');
    }

    if (!payload.relayer) {
      throw new Error(
        'Relayed V3 requires payload.relayer to be set by the sender before signing.',
      );
    }

    if (payload.version < 2) {
      throw new Error('Relayed V3 requires transaction version >= 2.');
    }

    const expectedRelayerAddress = this.signer.getAddress().bech32();
    const relayerAddress = Address.newFromBech32(payload.relayer);

    if (relayerAddress.toBech32() !== expectedRelayerAddress) {
      this.logger.warn(
        `Invalid relayer address. Expected ${expectedRelayerAddress}`,
      );
      throw new Error(
        `Invalid relayer address. Expected ${expectedRelayerAddress}`,
      );
    }

    const tx = new Transaction({
      nonce: BigInt(payload.nonce),
      value: BigInt(payload.value),
      receiver: Address.newFromBech32(payload.receiver),
      sender: Address.newFromBech32(payload.sender),
      relayer: relayerAddress,
      gasPrice: BigInt(payload.gasPrice),
      gasLimit: BigInt(payload.gasLimit),
      data: payload.data
        ? Uint8Array.from(Buffer.from(payload.data, 'utf8'))
        : new Uint8Array(0),
      chainID: payload.chainID,
      version: payload.version,
      options: payload.options,
      signature: Uint8Array.from(Buffer.from(payload.signature, 'hex')),
    });

    // Relayer adds relayerSignature
    const bytesToSign = this.transactionComputer.computeBytesForSigning(tx);
    tx.relayerSignature = Uint8Array.from(await this.signer.sign(bytesToSign));

    this.logger.log('Broadcasting Relayed V3 transaction...');
    // We do NOT simulate here as the goal is a rapid broadcast.
    // In production, simulation can be configured based on env vars.
    try {
      const txHash = await this.provider.sendTransaction(tx);
      this.logger.log(`Transaction sent with hash: ${txHash}`);
      return txHash;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`Broadcast failed: ${message}`);
      throw new Error(`Broadcast failed: ${message}`);
    }
  }
}
