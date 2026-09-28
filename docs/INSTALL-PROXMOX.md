# Installing Finta on a Proxmox VM

A fresh install from GitHub on a dedicated Proxmox virtual machine, reachable from any computer or phone on your home network at `http://<VM-IP>:3000`. About 20 minutes.

## 1. Create the VM in Proxmox

Download the **Ubuntu Server 24.04 LTS** ISO to your Proxmox storage (**local → ISO Images → Download from URL**), then choose **Create VM**:

| Tab | Setting |
| --- | --- |
| General | Name `finta`, tick **Start at boot** |
| OS | The Ubuntu Server ISO |
| System | Defaults, and tick **Qemu Agent** |
| Disks | 20 GB, VirtIO SCSI, tick **Discard** if your storage is SSD |
| CPU | 1 socket, 2 cores, type `host` |
| Memory | 2048 MB |
| Network | Bridge `vmbr0`, model VirtIO |

Start the VM, open **Console**, and install Ubuntu with the defaults. Pick a username and password, and tick **Install OpenSSH server**.

After it reboots, log in on the console and run:

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y qemu-guest-agent git
sudo systemctl enable --now qemu-guest-agent
hostname -I
```

The first address printed is the VM's IP, for example `192.168.1.50`. In your router, add a **DHCP reservation** for it so it never changes (Finta is tied to this address).

From here, connect from your PC so you can paste commands: `ssh <you>@192.168.1.50`.

## 2. Install Finta

```bash
git clone https://github.com/harisbashir/finta.git ~/finta
cd ~/finta
bash scripts/install.sh
```

The installer:

1. installs Docker if it's missing;
2. asks for your time zone and the address people will type (the VM's IP is filled in — press Enter to accept);
3. writes `.env` (`APP_URL`, `TZ`, `COMPOSE_FILE=compose.vm.yaml`);
4. builds and starts Finta, and waits until it's healthy;
5. prints the address and your one-time **setup code**.

The first build takes a minute or two. Finta restarts on its own after crashes and VM reboots.

## 3. Create your household

1. On your PC, open the address the installer printed, e.g. `http://192.168.1.50:3000`. Always use this exact address.
2. Enter the setup code, your household name, your name, email, and a password of 10 or more characters.
3. Choose **Create Household**. Turn on **Start with example data** only if you want to explore first.

Lost the setup code? `docker compose logs finta | grep "Setup code"` (use `sudo docker …` until you log out and back in once).

## 4. Start using it

- **Statements:** on **Money**, tap **Import**, choose **New Account…** for each chequing account, savings account and card, and pick the CSV from your bank. Try `docs/examples/*.csv` to see transfers pair up.
- **Your household:** **Settings → Invite Someone**, then open the link or scan the QR code on the same Wi-Fi.
- **Phone:** open the address in Safari or Chrome, then **Share → Add to Home Screen**.
- **Security:** passkeys need HTTPS, so on this home setup turn on **Settings → Sign-In & Security → Two-Factor** instead.

## Everyday care

Run these on the VM inside `~/finta`.

| Task | Command |
| --- | --- |
| Update to the latest version | `bash scripts/update.sh` (backs up to `./backups` first) |
| Back up now | `docker compose exec finta node server/cli.js backup` |
| Copy backups out of the container | `docker compose cp finta:/data/backups ./backups` |
| Status / live log | `docker compose ps` · `docker compose logs -f finta` |
| Reset a forgotten password | `docker compose exec finta node server/cli.js reset-password you@example.com` |
| Turn off a lost two-factor device | `docker compose exec finta node server/cli.js disable-2fa you@example.com` |
| VM got a new IP | `bash scripts/install.sh --ip <new-ip>` |

**Proxmox backups.** Also schedule a backup of the whole VM: **Datacenter → Backup → Add**, choose the `finta` VM, mode **Snapshot**, daily. Keep copies off the Proxmox host (a NAS or Proxmox Backup Server) — the data is your household's finances.

## Troubleshooting

| What you see | Fix |
| --- | --- |
| “Request blocked (cross-site)” | You opened a different address than `APP_URL` (e.g. `localhost` or an old IP). Use the printed address, or rerun `bash scripts/install.sh --ip <address>` |
| Browser can't reach the address | Check the VM's network is on `vmbr0`, `docker compose ps` shows it running, and, if you enabled `ufw`, `sudo ufw allow 3000/tcp` |
| `permission denied … docker.sock` | Log out and back in once after installing, or prefix with `sudo` |
| Build stops downloading `node:22-alpine` | The VM has no internet or DNS: `ping -c1 github.com` |

**Don't** forward port 3000 from your router: this setup is plain HTTP. To use Finta outside the house, run `bash scripts/install.sh --domain home.example.com` on a machine that a domain name points to, with ports 80 and 443 open. It then gets HTTPS automatically, and passkeys start working.
