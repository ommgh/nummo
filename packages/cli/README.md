# nummo

Command-line tool for [nummo](https://github.com/ommgh/nummo): open-source usage billing and entitlements, settled in USDC on Solana.

```bash
npx nummo init                          # write a starter nummo.config.ts
npx nummo login --key nummo_sk_test_... # store your API key (add --api <url> when self-hosting)
npx nummo push                          # apply the pricing config
npx nummo plans publish                 # publish paid plans on Solana
npx nummo verify                        # check billing records against the chain
npx nummo --help                        # everything else
```

Needs Node 22.18 or newer, which loads `nummo.config.ts` without a build step. Docs: the [guide](https://github.com/ommgh/nummo/tree/master/docs/guide). Licence: Apache-2.0.
