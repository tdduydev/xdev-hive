# sshd thật cho test cách triển khai ssh-script. Image gốc đổi qua build arg BASE_IMAGE (testing/sshd.ts lấy từ
# HIVE_TEST_SSHD_BASE_IMAGE) để tránh giới hạn lượt tải của Docker Hub.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub \
  && mkdir -p /run/sshd \
  && useradd --create-home --shell /bin/sh deploy \
  && usermod -p '*' deploy \
  && mkdir -p /home/deploy/.ssh \
  && chmod 700 /home/deploy/.ssh \
  && touch /home/deploy/.ssh/authorized_keys \
  && chmod 600 /home/deploy/.ssh/authorized_keys \
  && chown -R deploy:deploy /home/deploy/.ssh \
  && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' \
    > /etc/ssh/sshd_config.d/hive-test.conf

# Checkout trên Windows có thể đổi LF thành CRLF: bỏ \r để sh chạy được.
COPY fake-docker.sh /usr/local/bin/docker
RUN sed -i 's/\r$//' /usr/local/bin/docker && chmod 755 /usr/local/bin/docker

EXPOSE 22
# Host key sinh lúc container chạy: mỗi container một bộ khoá, test "host key đổi" chỉ cần container mới.
CMD ["/bin/sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
