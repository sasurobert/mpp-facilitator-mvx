/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { MppxService } from './mppx.service';
import { RelayerService, RelayedV3Payload } from './relayer.service';
import { StorageService } from './storage.service';

/** Simple in-memory rate limiter for relayed transactions */
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  isAllowed(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const valid = timestamps.filter((t) => now - t < this.windowMs);
    if (valid.length >= this.maxRequests) return false;
    valid.push(now);
    this.requests.set(key, valid);
    return true;
  }
}

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);
  private readonly relayerRateLimiter = new RateLimiter(
    60_000, // 1 minute window
    parseInt(process.env.MPP_RELAY_RATE_LIMIT || '10', 10),
  );

  constructor(
    private readonly mppxService: MppxService,
    private readonly relayerService: RelayerService,
    private readonly storageService: StorageService,
  ) {}

  @Get('protected-resource')
  async getProtectedResource(
    @Req() req: ExpressRequest,
    @Res() res: ExpressResponse,
  ) {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const fetchReq = new Request(fullUrl, {
      method: req.method,
      headers: req.headers as HeadersInit,
    });

    const amount =
      (req.query.amount as string) ||
      process.env.MPP_DEFAULT_AMOUNT ||
      '1000000000000000000';

    const opaque = req.query.opaque as string;
    const digest = req.get('Digest');
    const meta = opaque ? { data: opaque } : undefined;
    const recipient = this.relayerService.getRelayerAddress();

    const composeResult = this.mppxService.instance.compose([
      this.mppxService.mvxChargeMethod,
      { amount, digest, meta, ...(recipient ? { recipient } : {}) },
    ]);
    const result = await composeResult(fetchReq);

    if (result.status === 402) {
      const challengeResponse = result.challenge as Response;

      // Extract headers from challenge response
      challengeResponse.headers.forEach((val: string, key: string) =>
        res.setHeader(key, val),
      );

      // Ensure Cache-Control is set as per spec
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/problem+json');

      const challengeStr = await challengeResponse.text();

      // Extract challenge ID for the problem detail if possible
      // Format usually: Payment id="...", ...
      const challengeId = this.extractChallengeId(challengeStr);
      await this.savePendingChallenge({
        challengeId,
        recipient,
        amount,
        opaque,
        digest,
      });

      // Construct Problem Details JSON (RFC 9457)
      const problemDetail = {
        type: 'https://mpp.dev/errors/payment-required',
        title: 'Payment Required',
        status: 402,
        detail: `This resource requires a payment of ${amount} units.`,
        challengeId,
        challenge: challengeStr,
      };

      res.status(402).json(problemDetail);
      return;
    }

    if (result.status === 200) {
      const receiptResponse = result.withReceipt(
        new Response('Here is your protected data!'),
      );
      (receiptResponse as Response).headers.forEach(
        (val: string, key: string) => res.setHeader(key, val),
      );
      res.status(200).send(await (receiptResponse as Response).text());
      return;
    }

    res.status(500).send('Unexpected status');
  }

  @Get('session-resource')
  async getSessionResource(
    @Req() req: ExpressRequest,
    @Res() res: ExpressResponse,
  ) {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const fetchReq = new Request(fullUrl, {
      method: req.method,
      headers: req.headers as HeadersInit,
    });

    const amount =
      (req.query.amount as string) ||
      process.env.MPP_DEFAULT_AMOUNT ||
      '1000000000000000000';

    const opaque = req.query.opaque as string;
    const digest = req.get('Digest');
    const meta = opaque ? { data: opaque } : undefined;
    const recipient = this.relayerService.getRelayerAddress();

    const composeResult = this.mppxService.instance.compose([
      this.mppxService.mvxSessionMethod,
      {
        amount,
        digest,
        meta,
        duration: '1h',
        ...(recipient ? { recipient } : {}),
      },
    ]);
    const result = await composeResult(fetchReq);

    if (result.status === 402) {
      const challengeResponse = result.challenge as Response;

      challengeResponse.headers.forEach((val: string, key: string) =>
        res.setHeader(key, val),
      );

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/problem+json');

      const challengeStr = await challengeResponse.text();
      const challengeId = this.extractChallengeId(challengeStr);
      await this.savePendingChallenge({
        challengeId,
        recipient,
        amount,
        opaque,
        digest,
      });

      const problemDetail = {
        type: 'https://mpp.dev/errors/payment-required',
        title: 'Payment Required',
        status: 402,
        detail: `This resource requires a session payment of ${amount} units.`,
        challengeId,
        challenge: challengeStr,
      };

      res.status(402).json(problemDetail);
      return;
    }

    if (result.status === 200) {
      const receiptResponse = result.withReceipt(
        new Response('Here is your continuous session data stream...'),
      );
      (receiptResponse as Response).headers.forEach(
        (val: string, key: string) => res.setHeader(key, val),
      );
      res.status(200).send(await (receiptResponse as Response).text());
      return;
    }

    res.status(500).send('Unexpected status');
  }

  @Get('subscription-resource')
  async getSubscriptionResource(
    @Req() req: ExpressRequest,
    @Res() res: ExpressResponse,
  ) {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const fetchReq = new Request(fullUrl, {
      method: req.method,
      headers: req.headers as HeadersInit,
    });

    const amount =
      (req.query.amount as string) ||
      process.env.MPP_DEFAULT_AMOUNT ||
      '1000000000000000000';

    const opaque = req.query.opaque as string;
    const digest = req.get('Digest');
    const meta = opaque ? { data: opaque } : undefined;
    const recipient = this.relayerService.getRelayerAddress();

    const composeResult = this.mppxService.instance.compose([
      this.mppxService.mvxSubscriptionMethod,
      {
        amount,
        digest,
        meta,
        interval: 'monthly',
        ...(recipient ? { recipient } : {}),
      },
    ]);
    const result = await composeResult(fetchReq);

    if (result.status === 402) {
      const challengeResponse = result.challenge as Response;

      challengeResponse.headers.forEach((val: string, key: string) =>
        res.setHeader(key, val),
      );

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/problem+json');

      const challengeStr = await challengeResponse.text();
      const challengeId = this.extractChallengeId(challengeStr);
      await this.savePendingChallenge({
        challengeId,
        recipient,
        amount,
        opaque,
        digest,
      });

      const problemDetail = {
        type: 'https://mpp.dev/errors/payment-required',
        title: 'Payment Required',
        status: 402,
        detail: `This resource requires a subscription payment of ${amount} units.`,
        challengeId,
        challenge: challengeStr,
      };

      res.status(402).json(problemDetail);
      return;
    }

    if (result.status === 200) {
      const receiptResponse = result.withReceipt(
        new Response('Welcome to your premium subscription content!'),
      );
      (receiptResponse as Response).headers.forEach(
        (val: string, key: string) => res.setHeader(key, val),
      );
      res.status(200).send(await (receiptResponse as Response).text());
      return;
    }

    res.status(500).send('Unexpected status');
  }

  @Post('submit_relayed_v3')
  async submitRelayedV3(
    @Body() payload: RelayedV3Payload,
    @Req() req: ExpressRequest,
  ) {
    // Rate limiting by sender address
    const rateLimitKey = payload.sender || req.ip || 'unknown';
    if (!this.relayerRateLimiter.isAllowed(rateLimitKey)) {
      throw new HttpException(
        'Rate limit exceeded for relayed transactions',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      const txHash = await this.relayerService.submitRelayedV3(payload);
      return { success: true, txHash };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpException(message, HttpStatus.BAD_REQUEST);
    }
  }

  @Get('relayer_address')
  getRelayerAddress() {
    const address = this.relayerService.getRelayerAddress();
    if (!address) {
      throw new HttpException('Relayer not configured', HttpStatus.NOT_FOUND);
    }
    return { address };
  }

  @Post('challenges')
  async createChallenge(
    @Body()
    body: {
      id: string;
      receiver: string;
      amount: string;
      currency: string;
      chainId?: string;
      expiresAt?: string;
      opaque?: string;
      digest?: string;
      source?: string;
    },
  ) {
    await this.storageService.save({
      id: body.id,
      txHash: '',
      payer: '',
      receiver: body.receiver,
      amount: body.amount,
      currency: body.currency || 'EGLD',
      chainId: body.chainId || 'D',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      opaque: body.opaque || null,
      digest: body.digest || null,
      source: body.source || null,
    });
    return { success: true, challengeId: body.id };
  }

  private extractChallengeId(challengeStr: string): string | undefined {
    const idMatch = challengeStr.match(/id="([^"]+)"/);
    if (idMatch) return idMatch[1];

    try {
      const parsed = JSON.parse(challengeStr) as { challengeId?: string };
      if (parsed.challengeId) return parsed.challengeId;
    } catch {
      // ignore parse failures and fallback to regex extraction only
    }

    const challengeIdMatch = challengeStr.match(/"challengeId":"([^"]+)"/);
    return challengeIdMatch ? challengeIdMatch[1] : undefined;
  }

  private async savePendingChallenge(data: {
    challengeId?: string;
    recipient?: string;
    amount: string;
    opaque?: string;
    digest?: string;
  }): Promise<void> {
    if (!data.challengeId || !data.recipient) {
      return;
    }

    try {
      await this.storageService.save({
        id: data.challengeId,
        txHash: '',
        payer: '',
        receiver: data.recipient,
        amount: data.amount,
        currency: process.env.MPP_DEFAULT_CURRENCY || 'EGLD',
        chainId: process.env.MPP_CHAIN_ID || 'D',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        opaque: data.opaque ? JSON.stringify({ data: data.opaque }) : null,
        digest: data.digest || null,
        source: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to persist challenge ${data.challengeId}: ${message}`,
      );
    }
  }
}
