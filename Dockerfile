FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 planner && mkdir /data /config && chown planner /data /config
COPY server.py /opt/camera-planner/
COPY static /opt/camera-planner/static/
COPY start.py /opt/camera-planner/
WORKDIR /config
ENV PLANNER_DATA=/data
USER planner
EXPOSE 8080
CMD ["python", "/opt/camera-planner/start.py"]
