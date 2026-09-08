import { createContext, type ReactNode, useContext } from "react";

const ChatQuoteContext = createContext<(text: string) => void>(() => undefined);

/** Makes assistant content quotable without coupling message renderers to composer state. */
export function ChatQuoteProvider({ children, onQuote }: { children: ReactNode; onQuote: (text: string) => void }) {
  return <ChatQuoteContext.Provider value={onQuote}>{children}</ChatQuoteContext.Provider>;
}

/** Returns the composer-owned action used to turn selected text into a local Asset. */
export function useChatQuote() {
  return useContext(ChatQuoteContext);
}
