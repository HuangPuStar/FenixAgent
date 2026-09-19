import { useEffect, useRef } from "react";
import { pushContext, removeContext } from "./context-queue";

export function useContextQueue(key: string, text: string | (() => string)): void {
  const keyRef = useRef(key);
  const textRef = useRef(text);
  keyRef.current = key;
  textRef.current = text;

  useEffect(() => {
    const resolvedText = typeof textRef.current === "function" ? textRef.current() : textRef.current;
    pushContext(keyRef.current, resolvedText);

    return () => {
      removeContext(keyRef.current);
    };
  }, []);
}
