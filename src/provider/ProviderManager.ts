import { JSONRpcProvider } from 'opnet';
import { config, bitcoinNetwork } from '../config.js';

/**
 * Singleton OPNet JSON-RPC provider.
 */
class ProviderManager {
    private static instance: ProviderManager | undefined;
    private readonly provider: JSONRpcProvider;

    private constructor() {
        this.provider = new JSONRpcProvider({
            url: config.rpcUrl,
            network: bitcoinNetwork,
        });
    }

    /**
     * Get singleton instance.
     */
    public static getInstance(): ProviderManager {
        if (!ProviderManager.instance) {
            ProviderManager.instance = new ProviderManager();
        }
        return ProviderManager.instance;
    }

    /**
     * Get the underlying provider.
     */
    public getProvider(): JSONRpcProvider {
        return this.provider;
    }
}

export const providerManager = ProviderManager.getInstance();
