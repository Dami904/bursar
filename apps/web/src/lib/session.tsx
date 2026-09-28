import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createSiweMessage } from "viem/siwe";
import { useConnect, useConnection, useConnectors, useDisconnect, useSignMessage } from "wagmi";
import { api, loadSession, saveSession, whenSignedOut, type Session } from "./api.js";
import { config } from "./config.js";

interface SessionContextValue {
  session: Session | null;
  /** Connects the chosen wallet (if needed), then signs the sign-in message. */
  signIn(connectorId: string): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const connection = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connect } = useConnect();
  const { mutateAsync: disconnect } = useDisconnect();
  const { mutateAsync: signMessage } = useSignMessage();
  const queryClient = useQueryClient();

  const forget = useCallback(() => {
    saveSession(null);
    setSession(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => whenSignedOut(forget), [forget]);

  const signIn = useCallback(
    async (connectorId: string) => {
      let address = connection.address;
      if (address === undefined || connection.connector?.id !== connectorId) {
        const connector = connectors.find((c) => c.id === connectorId);
        if (connector === undefined) throw new Error("That wallet isn't available here");
        const result = await connect({ connector });
        address = result.accounts[0];
      }
      if (address === undefined) throw new Error("No account in that wallet");
      const { nonce } = await api<{ nonce: string }>("/auth/nonce", { body: {} });
      const message = createSiweMessage({
        address,
        chainId: config.chain.id,
        domain: window.location.host,
        uri: window.location.origin,
        nonce,
        version: "1",
        statement: "Sign in to Bursar",
        issuedAt: new Date(),
      });
      const signature = await signMessage({ message, account: address });
      const signedIn = await api<Session>("/auth/verify", { body: { message, signature } });
      saveSession(signedIn);
      setSession(signedIn);
    },
    [connection.address, connection.connector?.id, connectors, connect, signMessage],
  );

  const signOut = useCallback(async () => {
    await api("/auth/logout", { body: {} }).catch(() => undefined);
    await disconnect().catch(() => undefined);
    forget();
  }, [disconnect, forget]);

  return (
    <SessionContext.Provider value={{ session, signIn, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const value = useContext(SessionContext);
  if (value === null) throw new Error("useSession outside SessionProvider");
  return value;
}
