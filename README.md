# pfpRent

Pays people in $PFP for wearing the coin as their X profile picture. The site, the payout bot and your admin page are all in this one folder.

## Put it online (Railway)

1. Make a new GitHub repo and upload everything in this folder.
2. railway.com > New Project > Deploy from GitHub repo > pick it.
3. Service > Settings > Networking > Generate Domain (copy it).
4. Service > Settings > Volumes > Add Volume, mount path `/data`.
5. Service > Variables, add:
   - `DATA_DIR` = `/data`
   - `PFP_MINT` = the $PFP CA
   - `RPC_URL` = `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY` (free key at helius.dev)
   - `ADMIN_WALLETS` = your Phantom address
   - `ADMIN_KEY` = a long random password
   - `PUBLIC_URL` = `https://` + the domain from step 3
   - `TWITTERAPI_KEY` = key from twitterapi.io (recommended; needed for retweet raids)
6. Open `https://YOUR-DOMAIN/admin` > Connect admin wallet.
7. Treasury > Back up key. Keep the file offline.
8. Fund the treasury > send $PFP, and about 0.2 SOL for fees.
9. The hourly pot > pick how much pays out > Save.
10. Payouts > Go live.

The site is at `https://YOUR-DOMAIN`. Custom domain: Settings > Networking > Custom Domain.

## Sign in with X (optional)

1. developer.x.com > create an app.
2. User authentication settings > OAuth 2.0 > Web App.
3. Callback URL: `https://YOUR-DOMAIN/auth/x/callback`. Website: `https://YOUR-DOMAIN`.
4. Copy Client ID and Client Secret into `X_CLIENT_ID` and `X_CLIENT_SECRET`.

X bills about $0.01 per login from prepaid credits. Without it, people verify by posting a code (free).

## Pot modes (admin > The hourly pot)

- **percent**: pays X% of the treasury's free $PFP every hour.
- **fixed**: pays a set amount of $PFP every hour.
- **fees**: claims pump.fun creator fees every hour, buys $PFP with them, pays it out. The treasury must be the wallet that created $PFP: put that wallet's private key in `TREASURY_SECRET`.

## Raids

Admin > Start a raid > paste the post link, pot, hours.
- Quote and reply raids: people paste their post link on the site.
- Retweet raids: counted automatically at the end (needs `TWITTERAPI_KEY`).

## How the checks work

- Every member's X picture is checked about every 20 min, at random times.
- The bot looks for the coin frame (thick white rim, thin inner ring). Both the plain logo and "your face on the coin" from the site count.
- Weight = follower band × name-tag bonus × streak bonus. It's paid for the share of checks where the coin was on.
- Each hour's pot is split by weight. Owed $PFP is sent from the treasury, with a Solscan link for every payout.

All settings are in `env.example`. Most can also be changed live on /admin.
