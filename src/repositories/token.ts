/** Token 仓储 — 内存 Map 存储，遗留 token 认证 */
export interface TokenRecord {
  username: string;
  createdAt: Date;
}

export interface ITokenRepo {
  create(username: string, token: string): Promise<void>;
  getByToken(token: string): Promise<TokenRecord | undefined>;
  reset(): void;
}

class InMemoryTokenRepo implements ITokenRepo {
  private tokens = new Map<string, TokenRecord>();

  async create(username: string, token: string): Promise<void> {
    this.tokens.set(token, { username, createdAt: new Date() });
  }

  async getByToken(token: string): Promise<TokenRecord | undefined> {
    return this.tokens.get(token);
  }

  reset(): void {
    this.tokens.clear();
  }
}

export const tokenRepo: ITokenRepo = new InMemoryTokenRepo();
