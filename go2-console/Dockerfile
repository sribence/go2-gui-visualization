FROM python:3.10-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 9200

CMD ["python", "run.py", "--host", "0.0.0.0", "--port", "9200", "--live"]
