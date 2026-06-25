import { Test, TestingModule } from '@nestjs/testing';
import { RelayerService, RelayedV3Payload } from './relayer.service';
import { UserSigner } from '@multiversx/sdk-wallet';
import { ProxyNetworkProvider } from '@multiversx/sdk-network-providers';
import {
  Address,
  Transaction,
  TransactionComputer,
} from '@multiversx/sdk-core';
import * as fs from 'fs';

jest.mock('fs');
jest.mock('@multiversx/sdk-wallet');
jest.mock('@multiversx/sdk-network-providers');
jest.mock('@multiversx/sdk-core', () => {
  return {
    Address: {
      newFromBech32: jest.fn().mockImplementation((address) => {
        return {
          toBech32: () => address,
        };
      }),
    },
    Transaction: jest.fn().mockImplementation(() => {
      return {
        relayerSignature: undefined,
      };
    }),
    TransactionComputer: jest.fn().mockImplementation(() => {
      return {
        computeBytesForSigning: jest
          .fn()
          .mockReturnValue(new Uint8Array([1, 2, 3])),
      };
    }),
  };
});

describe('RelayerService', () => {
  let service: RelayerService;
  let mockSigner: any;
  let mockProvider: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.RELAYER_PEM_PATH = './alice.pem';

    mockSigner = {
      getAddress: jest.fn().mockReturnValue({
        bech32: () => 'erd1relayerdummyaddress',
      }),
      sign: jest.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
    };
    (UserSigner.fromPem as jest.Mock).mockReturnValue(mockSigner);

    mockProvider = {
      sendTransaction: jest.fn().mockResolvedValue('dummyTxHash'),
    };
    (ProxyNetworkProvider as jest.Mock).mockReturnValue(mockProvider);

    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('dummy pem content');

    const module: TestingModule = await Test.createTestingModule({
      providers: [RelayerService],
    }).compile();

    service = module.get<RelayerService>(RelayerService);
  });

  afterEach(() => {
    delete process.env.RELAYER_PEM_PATH;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('constructor', () => {
    it('should initialize without errors if pem file exists', () => {
      expect(fs.existsSync).toHaveBeenCalled();
      expect(fs.readFileSync).toHaveBeenCalled();
      expect(UserSigner.fromPem).toHaveBeenCalledWith('dummy pem content');
      expect(service.getRelayerAddress()).toBe('erd1relayerdummyaddress');
    });

    it('should handle fs.readFileSync error gracefully', () => {
      (fs.readFileSync as jest.Mock).mockImplementationOnce(() => {
        throw new Error('read error');
      });

      const newService = new RelayerService();
      expect(newService.getRelayerAddress()).toBeUndefined();
    });

    it('should handle missing pem file gracefully', () => {
      (fs.existsSync as jest.Mock).mockReturnValueOnce(false);

      const newService = new RelayerService();
      expect(newService.getRelayerAddress()).toBeUndefined();
    });
  });

  describe('setSignerFromPem', () => {
    it('should set sign from pem content', () => {
      service.setSignerFromPem('new pem content');
      expect(UserSigner.fromPem).toHaveBeenCalledWith('new pem content');
    });
  });

  describe('submitRelayedV3', () => {
    let payload: RelayedV3Payload;

    beforeEach(() => {
      payload = {
        nonce: 10,
        value: '100000',
        receiver: 'erd1receiver',
        sender: 'erd1sender',
        relayer: 'erd1relayerdummyaddress',
        gasPrice: 1000000000,
        gasLimit: 60000000,
        data: 'some data',
        chainID: 'D',
        version: 2,
        options: 0,
        signature: 'abcdef',
      };
    });

    it('should throw an error if signer is not configured', async () => {
      (fs.existsSync as jest.Mock).mockReturnValueOnce(false);
      const noSignerService = new RelayerService();
      await expect(noSignerService.submitRelayedV3(payload)).rejects.toThrow(
        'Relayer is not configured.',
      );
    });

    it('should throw an error if no relayer is set in payload', async () => {
      payload.relayer = '';
      await expect(service.submitRelayedV3(payload)).rejects.toThrow(
        'Relayed V3 requires payload.relayer to be set by the sender before signing.',
      );
    });

    it('should throw an error if version < 2', async () => {
      payload.version = 1;
      await expect(service.submitRelayedV3(payload)).rejects.toThrow(
        'Relayed V3 requires transaction version >= 2.',
      );
    });

    it('should throw an error if relayer address does not match', async () => {
      payload.relayer = 'erd1differentrelayer';
      await expect(service.submitRelayedV3(payload)).rejects.toThrow(
        'Invalid relayer address. Expected erd1relayerdummyaddress',
      );
    });

    it('should successfully submit the transaction', async () => {
      const txHash = await service.submitRelayedV3(payload);

      expect(Address.newFromBech32).toHaveBeenCalledWith(payload.receiver);
      expect(Address.newFromBech32).toHaveBeenCalledWith(payload.sender);
      expect(Address.newFromBech32).toHaveBeenCalledWith(payload.relayer);
      expect(Transaction).toHaveBeenCalled();

      // Access the provider created inside the service
      // Verify sendTransaction was called
      expect(mockProvider.sendTransaction).toHaveBeenCalled();

      expect(txHash).toBe('dummyTxHash');
    });

    it('should successfully submit the transaction without data', async () => {
      payload.data = undefined;
      const txHash = await service.submitRelayedV3(payload);
      expect(Transaction).toHaveBeenCalled();
      expect(mockProvider.sendTransaction).toHaveBeenCalled();
      expect(txHash).toBe('dummyTxHash');
    });

    it('should throw an error if broadcast fails', async () => {
      mockProvider.sendTransaction.mockRejectedValueOnce(
        new Error('api error'),
      );
      await expect(service.submitRelayedV3(payload)).rejects.toThrow(
        'Broadcast failed: api error',
      );
    });

    it('should throw an error if broadcast fails with non-error object', async () => {
      mockProvider.sendTransaction.mockRejectedValueOnce('string error');
      await expect(service.submitRelayedV3(payload)).rejects.toThrow(
        'Broadcast failed: string error',
      );
    });
  });
});
