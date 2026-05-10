import sqlite3

db_path = "/mfa/corpus/corpus.db"
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

print("--- phone_interval data ---")
cursor.execute("SELECT begin, end, phone_id, phone_goodness FROM phone_interval LIMIT 20")
for row in cursor.fetchall():
    print(row)

print("\n--- phone table data ---")
cursor.execute("SELECT id, phone FROM phone LIMIT 10")
for row in cursor.fetchall():
    print(row)

print("\n--- phone_goodness statistics ---")
cursor.execute("SELECT MIN(phone_goodness), MAX(phone_goodness), AVG(phone_goodness) FROM phone_interval")
stats = cursor.fetchone()
print(f"Min: {stats[0]}, Max: {stats[1]}, Avg: {stats[2]}")

conn.close()
