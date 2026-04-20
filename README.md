<div align="center">

# nodejs-pool

Node.js mining pool backend with LMDB share storage, MySQL-backed configuration, and a modular PM2 runtime.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-111111.svg" alt="Node 18+">
  <img src="https://img.shields.io/badge/platform-Ubuntu%2024.04-111111.svg" alt="Ubuntu 24.04">
  <img src="https://img.shields.io/badge/focus-pool%20backend-111111.svg" alt="Pool backend">
</p>

</div>

## Overview

`nodejs-pool` is the backend used for MoneroOcean-style mining pool deployments. It keeps share state in LMDB, stores configuration and accounting in MySQL, and splits runtime responsibilities into small services that can be scaled or restarted independently.

The backend is typically paired with a separate website/frontend. The reference deployment uses a static frontend and points it at the API service exposed by this repo.

## Service Layout

| Module | Purpose |
| --- | --- |
| `api` | Main frontend and account API, typically exposed on port `8001` |
| `remote_share` | Share ingress for local/remote pool nodes, typically exposed on port `8000` at `/leafApi` |
| `pool` | Stratum/miner entrypoint |
| `block_manager` | Unlocks blocks and distributes rewards |
| `payments` | Handles miner payouts |
| `worker` | Refreshes stats, health checks, and notifications |
| `long_runner` | Cleans and compacts share data over time |
| `pool_stats` | Aggregates pool statistics |
| `altblockManager` / `altblockExchange` | Optional multi-coin helpers under [`lib2/`](lib2/) |

## Quick Setup

### What You Need

- A clean Ubuntu `24.04` x86_64 server
- Root access for the initial installer run
- Cloudflare-managed DNS for both the website hostname and API hostname
- A Cloudflare API token with `Zone.Zone (Read)` and `Zone.DNS (Edit)`
- At least `8 GB RAM`, `2 CPU cores`, and about `150 GB` of SSD storage for a single-node XMR deployment
- More storage if you plan to run extra daemons or optional `lib2` services

Leaf nodes need far less disk than a full single-node install because they do not need the full main-server footprint.

> The deploy scripts assume a fresh host. They create a `user` account, install Monero, MySQL, Nginx, Node via NVM, PM2, wallet files, SQL schema, and base pool configuration.

If your DNS or certificate flow is different, adapt [`deployment/deploy.bash`](deployment/deploy.bash) before running it.

### Single-Server Deploy

Run the installer as `root`:

```bash
curl -L https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/deploy.bash | \
bash -x -s -- pool.example.com api.pool.example.com "Cloudflare API Token" ops@example.com
```

When the script finishes:

1. Switch to the pool user and load Node from NVM.
2. Review `/home/user/nodejs-pool/config.json`.
3. Update `bind_ip`, `hostname`, `pool_id`, and any SQL-backed pool settings you want to change before miners connect.
4. Start the `pool` module manually after you finish review.

```bash
su - user
cd ~/nodejs-pool
source ~/.nvm/nvm.sh
pm2 start init.js --name=pool --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z" -- --module=pool
pm2 save
```

### Important Paths

| Path | Purpose |
| --- | --- |
| `/home/user/nodejs-pool/config.json` | Main local runtime config |
| `/home/user/pool_db/` | LMDB share database |
| `/home/user/wallets/` | Generated XMR pool and fee wallet files |
| `/root/mysql_pass` | MySQL root password created by the installer |
| `pool.port_config` | Mining ports and difficulty settings stored in MySQL |

### Leaf Nodes

For a leaf-only install:

```bash
curl -L https://raw.githubusercontent.com/MoneroOcean/nodejs-pool/master/deployment/leaf.bash | bash -x
```

After install, update the leaf config so it points at the main pool infrastructure, then start the `pool` module on that node.

### Docker And Optional Multi-Coin Stack

The Docker-based setup and the optional `lib2` altblock stack live in [`lib2/README.md`](lib2/README.md). Use that path if you are building out the broader multi-coin environment rather than the simpler default install.

## Manual / Dev Notes

- `package.json` currently requires Node `>=18`
- `config_example.json` provides the base local config shape
- The SQL schema is in [`deployment/base.sql`](deployment/base.sql)
- Run the test suite with:

```bash
npm test
```

## Operational Notes

- The deploy script starts most services for you, but leaves `pool` to be started after config review.
- The default SQL schema is XMR-oriented; adapt SQL-backed config if you are building for something else.
- Mining ports are not hardcoded in `config.json`; they are read from MySQL table `pool.port_config`.
- If LMDB appears stuck or the API stops moving, start with `mdb_stat -fear ~/pool_db/` and then review PM2 service state.

## Setup And Support

| Offering | Price |
| --- | --- |
| Setup | `1 XMR` |
| Setup support | `3 XMR` |

SSH access with a sudo-capable user and working DNS is expected for hands-on help.

Contact: `support@moneroocean.stream`

## Donation

If you want to quietly support the project:

```text
89TxfrUmqJJcb1V124WsUzA78Xa3UYHt7Bg8RGMhXVeZYPN8cE5CZEk58Y1m23ZMLHN7wYeJ9da5n5MXharEjrm41hSnWHL
```

## Contributors

- [MoneroOcean](https://github.com/MoneroOcean) for the long-running maintenance branch, deployment work, multi-coin evolution, and the recent hardening and test coverage push
- Alexander Blair and [Snipa22](https://github.com/Snipa22) for the original public `nodejs-pool` codebase and early architecture
- [Zone117x](https://github.com/zone117x) for the original [node-cryptonote-pool](https://github.com/zone117x/node-cryptonote-pool) stratum foundation
- [1rV1N](https://github.com/1rV1N), Mine Coins, Learner, [M5M400](https://github.com/M5M400), and [techandbeers](https://github.com/techandbeers) for fixes, docs, and operational improvements
- [Wolf0](https://github.com/wolf9466/) and [OhGodAGirl](https://github.com/ohgodagirl) for AES-NI hashing work used by the broader pool stack
