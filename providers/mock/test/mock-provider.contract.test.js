import { MockProvider } from '../src/mock-provider.js';
import { defineProviderContract } from '../../test-support/provider-contract.js';

defineProviderContract('MockProvider', () => new MockProvider(), { optional: ['snapshots', 'media', 'settings'] });
