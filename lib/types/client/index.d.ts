import { type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
interface RemoteModelCatalogEffort {
    id: string;
    name: string;
}
interface ModelCatalogModel {
    id: string;
    name: string;
    description?: string;
    reasoning?: {
        efforts?: RemoteModelCatalogEffort[];
    };
}
type ModelProviderGroup = {
    id: string;
    name: string;
    models: ModelCatalogModel[];
};
interface RemoteModelCatalogResponse {
    ok: boolean;
    value?: {
        default?: {
            provider: string;
            model: string;
            reasoningEffort?: string;
        };
        groups: ModelProviderGroup[];
        failures?: Array<{
            provider?: string;
            message?: string;
        }>;
    };
    error?: {
        code?: string;
        message?: string;
    };
}
interface RemoteSessionHandle {
    modelCatalog(): Promise<RemoteModelCatalogResponse>;
}
interface RemoteHandle {
    session: RemoteSessionHandle;
}
export declare const name = "dsh-inline-chat-client";
export declare const inject: readonly ["connection", "remote", "remote.session", "sessions"];
interface SessionBindingLike {
    session?: {
        projections?: {
            faceOf(key: string): {
                getSnapshot(): unknown;
            };
        };
    };
}
interface SessionsServiceLike {
    list?: {
        getSnapshot?(): {
            current?: unknown;
        };
        subscribe?(fn: () => void): () => void;
    };
    binding?(id: unknown): SessionBindingLike | undefined;
}
interface ClientContext {
    connection: ConnectionHandle;
    remote: RemoteHandle;
    sessions: SessionsServiceLike;
    on?: (name: 'dispose', callback: () => void) => void;
}
export declare function apply(ctx: ClientContext): void;
export {};
//# sourceMappingURL=index.d.ts.map