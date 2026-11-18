# T5 集成测试与实测 N（300 连接）用 sshd 容器（本地构建，不入公共仓库）
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash ops && echo 'ops:ops-pass-123' | chpasswd
RUN mkdir -p /run/sshd
# 允许密码认证 + 放开并发限制（默认 MaxStartups 10：30:100 / MaxSessions 10，压 300 连接需放开）
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?MaxStartups.*/MaxStartups 1000:30:1000/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?MaxSessions.*/MaxSessions 200/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
