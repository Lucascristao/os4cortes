declare global {
  namespace Netlify {
    const env: {
      get(key: string): string | undefined;
      set(key: string, value: string): void;
    };
  }
}

export {};
