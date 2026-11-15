// Reads its own `process.env` and reports only whether each name was present,
// so a test can prove what the host actually handed the child. No values from
// the host are echoed back except the searx URL, which is not a secret.
export const nodes = [
  {
    id: 'com.example.env.read',
    version: '1.0.0',
    title: 'Read env',
    category: 'example',
    inputs: [],
    outputs: [{ kind: 'data', id: 'env', schema: { type: 'string' } }],
    async execute() {
      const read = (name) => process.env[name] ?? null
      return {
        env: JSON.stringify({
          PATH: read('PATH'),
          LC_ALL: read('LC_ALL'),
          Z1_SEARX_URL: read('Z1_SEARX_URL'),
          Z1_SEARX_STATE: read('Z1_SEARX_STATE'),
          Z1_GITHUB_TOKEN: read('Z1_GITHUB_TOKEN'),
          RIVER_API_KEY: read('RIVER_API_KEY'),
          Z1_PRIVATE_SECRET: read('Z1_PRIVATE_SECRET'),
          AWS_SECRET_ACCESS_KEY: read('AWS_SECRET_ACCESS_KEY'),
        }),
      }
    },
  },
]
