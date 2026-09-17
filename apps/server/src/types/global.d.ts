declare global {
  interface Request {
    // biome-ignore lint/suspicious/noExplicitAny: generic JSON return type
    json<T = any>(): Promise<T>;
  }

  interface Response {
    // biome-ignore lint/suspicious/noExplicitAny: generic JSON return type
    json<T = any>(): Promise<T>;
  }

  interface Body {
    // biome-ignore lint/suspicious/noExplicitAny: generic JSON return type
    json<T = any>(): Promise<T>;
  }
}

export {};
