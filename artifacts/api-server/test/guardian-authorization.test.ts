import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createAppHarness } from "./helpers/app-harness";

const ownerId = "user-owner";
const guardianId = "user-guardian";
const unrelatedId = "user-unrelated";
const sessionId = "drive-session-1";

test("guardian location authorization is enforced through the route", async (t) => {
  const contactsByWatcher = new Map<string, any[]>();
  const points = [
    {
      id: "point-1",
      sessionId,
      sessionType: "drive",
      lat: "-33.8688",
      lng: "151.2093",
      recordedAt: "2026-09-04T00:00:00.000Z",
    },
  ];

  const harness = await createAppHarness({
    async getDriveSession(id: string) {
      return id === sessionId ? ({ id: sessionId, userId: ownerId } as any) : undefined;
    },
    async getContactsLinkedToUser(watcherUserId: string) {
      return contactsByWatcher.get(watcherUserId) ?? [];
    },
    async getSettings(userId: string) {
      return userId === ownerId ? ({ userId, allowReports: true } as any) : undefined;
    },
    async getTripPoints(id: string, type: string) {
      assert.equal(id, sessionId);
      assert.equal(type, "drive");
      return points as any;
    },
  });

  t.after(() => harness.close());

  await t.test("guardian with permission can read the watched user's location", async () => {
    contactsByWatcher.set(guardianId, [
      { id: "contact-1", userId: ownerId, canViewLocation: true },
    ]);

    const response = await harness.request(
      `/api/drive/trail-public/${sessionId}`,
      { userId: guardianId },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), points);
  });

  await t.test("a user with no relationship receives 403", async () => {
    contactsByWatcher.set(unrelatedId, []);

    const response = await harness.request(
      `/api/drive/trail-public/${sessionId}`,
      { userId: unrelatedId },
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Not authorized" });
  });

  await t.test("a contact with canViewLocation false receives 403", async () => {
    contactsByWatcher.set(guardianId, [
      { id: "contact-1", userId: ownerId, canViewLocation: false },
    ]);

    const response = await harness.request(
      `/api/drive/trail-public/${sessionId}`,
      { userId: guardianId },
    );

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Not authorized" });
  });

  await t.test("removing a contact immediately revokes location access", async () => {
    contactsByWatcher.set(guardianId, [
      { id: "contact-1", userId: ownerId, canViewLocation: true },
    ]);

    const beforeRemoval = await harness.request(
      `/api/drive/trail-public/${sessionId}`,
      { userId: guardianId },
    );
    assert.equal(beforeRemoval.status, 200);

    contactsByWatcher.delete(guardianId);

    const afterRemoval = await harness.request(
      `/api/drive/trail-public/${sessionId}`,
      { userId: guardianId },
    );
    assert.equal(afterRemoval.status, 403);
    assert.deepEqual(await afterRemoval.json(), { error: "Not authorized" });
  });

  await t.test("a user can always read their own location", async () => {
    contactsByWatcher.delete(ownerId);

    const response = await harness.request(
      `/api/drive/trail-public/${sessionId}`,
      { userId: ownerId },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), points);
  });
});
