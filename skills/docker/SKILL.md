---
name: docker
description: 容器化应用、编写 Dockerfile / docker-compose、排查容器问题时使用
---

# 容器化

## Dockerfile 最佳实践

1. **多阶段构建**：builder 阶段编译，runtime 阶段只带产物，镜像最小化。
2. **基础镜像固定 tag**（如 `node:20-alpine`），不用 `latest`。
3. **非 root 运行**：`USER` 指定非特权用户。
4. **分层缓存**：先 COPY 依赖清单并安装（`npm install` / `pip install`），再 COPY 源码。
5. **健康检查**：`HEALTHCHECK` 指向存活端点；`EXPOSE` 声明端口。
6. `.dockerignore` 排除 node_modules/.git/日志。

## compose 要点

- 服务依赖用 `depends_on` + `condition: service_healthy`
- 数据卷挂载与端口映射显式声明
- 环境变量走 `.env`，敏感值不进 compose 文件

## 验证闭环

1. `docker build` 实际构建通过
2. `docker run` 起一次容器并验证健康检查
3. 排查：`docker logs`、`docker exec -it <id> sh` 进容器看现场
