FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 planner && mkdir /data /config && chown planner /data /config
WORKDIR /app
COPY server.py .
COPY static ./static
ARG APP_VERSION=development
ENV APP_VERSION=$APP_VERSION
ENV PLANNER_DATA=/data
USER planner
EXPOSE 8080
CMD ["python", "server.py"]
