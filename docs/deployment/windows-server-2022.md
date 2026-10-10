# Hub trên Windows Server 2022

Hướng dẫn dựng hub xDev Hive cho production trên một máy Windows Server 2022. Hub chạy dưới Podman trong một VM Linux nhỏ của Hyper-V. Các giá trị dưới đây là ví dụ, thay bằng giá trị thật của bạn:

| Giá trị | Ví dụ trong tài liệu | Ý nghĩa |
|---|---|---|
| `<HOST_IP>` | `10.0.0.20` | địa chỉ LAN của máy Windows; người dùng mở `http://<HOST_IP>:7788` |
| mạng được phép | `10.0.0.0/16`, dải VPN | ai được mở hub |
| VM | `192.168.250.10` | địa chỉ của VM trên mạng NAT nội bộ của host |

## 1. Vì sao là VM Linux, không phải Podman for Windows

- Image của hub là Linux (`node:*-slim`). Windows Containers không chạy được image Linux.
- Podman for Windows (`podman machine`, dựa trên WSL2 hoặc Hyper-V) được tài liệu của Podman ghi là cần *"Windows 11 or later"* ([podman-for-windows.md](https://github.com/containers/podman/blob/main/docs/tutorials/podman-for-windows.md)) và không nhắc tới Windows Server. Nó cũng nhắm tới máy của lập trình viên, không có chế độ chạy như dịch vụ khi khởi động máy.
- WSL2 có trên Windows Server 2022 (từ bản cập nhật KB5014678), nhưng chạy dưới tài khoản người dùng, không phải dịch vụ hệ thống. Vì vậy nó không phải nền production cho một hub cần tự lên lại sau khi reboot.

Kiến trúc chọn: **Hyper-V (vai trò có sẵn của Windows Server) + một VM AlmaLinux 9 minimal (hoặc RHEL 9) + Podman 5 chạy dưới systemd bằng Quadlet**. Podman là công cụ chính thức của dòng RHEL. AlmaLinux tương thích nhị phân với RHEL và không cần Ubuntu.

```
LAN / VPN ──► <HOST_IP>:7788 (Windows Firewall: chỉ các dải được phép)
                 │  WinNAT static mapping
                 ▼
          VM 192.168.250.10:7788  (AlmaLinux 9, Podman 5, systemd)
                 ├─ hive-hub        (image ghcr.io/tdduydev/xdev-hive@sha256:…)
                 └─ hive-seaweedfs  (chỉ trên mạng podman "hive", không publish)
          /srv/hive (ổ dữ liệu riêng): data, backups, seaweedfs, logs, state
```

Kích thước gợi ý cho VM: 4 vCPU, 8 GB RAM, ổ hệ điều hành 40 GB, ổ dữ liệu 100 GB. Host còn dư cho việc khác. Hub dùng ít tài nguyên, phần nặng nhất là backup và migration.

## 2. Bật Hyper-V

PowerShell với quyền Administrator trên host:

```powershell
Install-WindowsFeature -Name Hyper-V -IncludeManagementTools -Restart
```

Nếu chính máy Windows Server là một VM (VMware, Hyper-V khác), phải bật nested virtualization trên hypervisor bên ngoài trước.

## 3. Tạo VM, NAT, chuyển cổng và tường lửa

Tải ISO AlmaLinux 9 minimal (x86_64) về host, rồi chạy script trong repo:

```powershell
cd C:\xdev-hive\deploy\windows
.\New-HiveHost.ps1 -IsoPath D:\ISO\AlmaLinux-9-latest-x86_64-minimal.iso `
  -AllowedRemote 10.0.0.0/16,10.8.0.0/24
```

Script làm những việc sau (chạy lại nhiều lần vẫn an toàn):
- Tạo switch nội bộ `xdev-hive-nat` với NetNat `192.168.250.0/24`. Windows chỉ cho một NetNat mỗi máy, nên nếu đã có NAT khác thì script dừng và báo.
- Tạo VM Gen 2, Secure Boot template `MicrosoftUEFICertificateAuthority` (để boot Linux), một ổ hệ điều hành và một ổ dữ liệu riêng.
- Đặt VM tự khởi động cùng host (`AutomaticStartAction Start`) và tắt êm khi host tắt (`AutomaticStopAction ShutDown`), để SQLite đóng đúng cách.
- Thêm `Add-NetNatStaticMapping` chuyển `<HOST_IP>:7788` vào VM, và một luật tường lửa chỉ cho các dải trong `-AllowedRemote`.

Không có gì khác được mở ra ngoài: không SSH, không RDP vào VM, không API của Podman. Quản trị VM qua **Hyper-V Manager → Connect** (console) hoặc `vmconnect`.

## 4. Cài AlmaLinux trong VM

Trong console của VM, khi cài:
- Chọn **Minimal Install**.
- Mạng: địa chỉ tĩnh `192.168.250.10/24`, gateway `192.168.250.1`, DNS là DNS của công ty.
- Ổ thứ hai (ổ dữ liệu): định dạng XFS, mount vào `/srv/hive`.
- Tạo một tài khoản quản trị có sudo.

Sau khi cài:

```bash
sudo dnf -y update
sudo dnf -y install podman skopeo curl util-linux git
podman --version    # cần 5.x
```

## 5. Cài phần deploy của hub

Trong VM, lấy thư mục `deploy/podman` của repo. Repo public nên clone được trực tiếp. Hoặc copy thư mục này vào VM bằng console.

```bash
git clone --depth 1 https://github.com/tdduydev/xdev-hive.git /opt/xdev-hive
sudo bash /opt/xdev-hive/deploy/podman/install.sh
sudo vi /etc/xdev-hive/hub.env        # HIVE_ALLOWED_HOSTS=<HOST_IP>, các thiết lập khác
```

Nếu package trên GHCR để private, đăng nhập một lần bằng một token chỉ có quyền `read:packages`. Thông tin đăng nhập nằm ở `/etc/containers/auth.json` trong VM, không bao giờ nằm trong repo:

```bash
sudo podman login ghcr.io -u <github-user> --authfile /etc/containers/auth.json
```

Deploy lần đầu rồi xem trạng thái:

```bash
sudo hive-deploy
sudo hive-status
sudo systemctl start hive-deploy.timer     # từ giờ tự cập nhật theo tag prod
journalctl -u hive-hub | grep -i code     # mã một lần của trang thiết lập (HIVE_SETUP=1)
```

Mở `http://<HOST_IP>:7788`, làm theo trang thiết lập để tạo tài khoản admin, rồi bỏ `HIVE_SETUP=1` khỏi `hub.env`.

## 6. Tự cập nhật, khởi động lại máy, giám sát

- `hive-deploy.timer` cứ hai phút kiểm tra tag `prod` một lần. Có digest mới thì nó deploy (xem [podman-production.md](podman-production.md)). Sau mỗi bản phát hành không cần ai SSH hay RDP vào.
- Khi host khởi động lại: Hyper-V bật VM, systemd trong VM bật `hive-seaweedfs` và `hive-hub` theo đúng image digest đã deploy lần cuối.
- Giám sát phía Windows: `Watch-HiveHub.ps1 -Register` tạo một scheduled task 5 phút chạy một lần. Task này bật VM nếu VM đang tắt, và ghi vào Event Log (Application, nguồn `xDevHive`, ID 1000/1001/1002) mỗi khi hub đổi trạng thái giữa healthy và không healthy.

```powershell
.\Watch-HiveHub.ps1 -Register
Get-EventLog -LogName Application -Source xDevHive -Newest 20
```

## 7. HTTPS nội bộ (sau này)

Hub đọc `HIVE_TRUST_PROXY=1` khi đứng sau một reverse proxy terminate TLS. Cách gọn nhất là thêm một container Caddy (hoặc IIS ARR trên host) với chứng chỉ của CA nội bộ, publish cổng 443 thay cho 7788, rồi đổi luật tường lửa và NAT mapping cho cổng đó. Hub không cần đổi gì khác.

## Giới hạn đã biết

- Tài liệu của Microsoft ghi rằng WinNAT không hỗ trợ hairpin: từ chính host, `http://<HOST_IP>:7788` có thể không vào được. Kiểm từ host thì dùng `http://192.168.250.10:7788`.
- Chưa có Developer ID hay chứng chỉ cho GHCR pull qua proxy công ty. Nếu mạng bắt buộc đi qua proxy, đặt `HTTP(S)_PROXY` cho podman trong `/etc/containers/containers.conf`.
