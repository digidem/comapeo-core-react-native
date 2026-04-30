import { comapeo } from '@comapeo/core-react-native'
import {
	valueOf,
	type ComapeoDoc,
	type ComapeoValue,
	type FieldValue,
	type ObservationValue,
	type PresetValue,
	type RemoteDetectionAlertValue,
	type TrackValue,
} from '@comapeo/core/schema.js'
import type { MapeoProjectApi } from '@comapeo/ipc'
import { generate } from '@mapeo/mock-data'
import { getRandomBytes } from 'expo-crypto'
import { uint8ArrayToHex } from 'uint8array-extras'

import {
	delay,
	randomBool,
	randomDate,
	randomNum,
	removeUndefinedFields,
	round,
	sortById,
	type TestContext,
} from './utils'

function createDocumentRef(versionIdNumber = 0) {
	return {
		docId: uint8ArrayToHex(getRandomBytes(32)),
		versionId: `${uint8ArrayToHex(getRandomBytes(32))}/${versionIdNumber}`,
	}
}

export function test({
	describe,
	expect,
	expectAsync,
	it,
	jasmine,
}: TestContext) {
	const CREATE_COUNT = 100

	const FIXTURES: Array<
		| FieldValue
		| ObservationValue
		| PresetValue
		| RemoteDetectionAlertValue
		| TrackValue
	> = [
		{
			schemaName: 'observation',
			lat: -3,
			lon: 37,
			tags: {},
			attachments: [],
			metadata: { manualLocation: false },
		},
		{
			schemaName: 'preset',
			name: 'myPreset',
			tags: {},
			iconRef: createDocumentRef(),
			geometry: ['point'],
			addTags: {},
			removeTags: {},
			fieldRefs: [],
			terms: [],
			color: '#ff00ff',
		},
		{
			schemaName: 'field',
			type: 'text',
			tagKey: 'foo',
			label: 'my label',
			universal: false,
		},
		{
			schemaName: 'track',
			observationRefs: [createDocumentRef(), createDocumentRef()],
			tags: {},
			locations: [
				trackPositionFixture(),
				trackPositionFixture(),
				trackPositionFixture(),
			],
			presetRef: createDocumentRef(),
		},
		{
			schemaName: 'remoteDetectionAlert',
			detectionDateStart: new Date().toISOString(),
			detectionDateEnd: new Date().toISOString(),
			sourceId: uint8ArrayToHex(getRandomBytes(32)),
			metadata: { alert_type: 'fire' },
			geometry: {
				type: 'Point',
				coordinates: [-3, 37],
			},
		},
	]

	describe('project CRUD operations', () => {
		for (const value of FIXTURES) {
			const { schemaName } = value

			it(`create and read (${schemaName})`, async () => {
				const projectId = await comapeo.createProject()
				const project = await comapeo.getProject(projectId)
				const updates: Array<ComapeoDoc> = []
				project[schemaName].on('updated-docs', (docs) => updates.push(...docs))
				const written = await createWithMockData(
					project,
					schemaName,
					CREATE_COUNT,
				)
				const read = await Promise.all(
					written.map((doc) => project[schemaName].getByDocId(doc.docId)),
				)

				// 'return create() matches return of getByDocId()'
				expect(sortById(written)).toEqual(sortById(read))

				// 'updated-docs emitted'
				expect(sortById(updates)).toEqual(sortById(written))

				// 'Doc marked with createdBy'
				expect(read[0].createdBy).toEqual(await comapeo.deviceId())

				// 'Doc marked with updatedBy'
				expect(read[0].updatedBy).toEqual(await comapeo.deviceId())
			})

			it(`update (${schemaName})`, async () => {
				const projectId = await comapeo.createProject()
				const project = await comapeo.getProject(projectId)
				const written = await create(project, value)
				const updateValue = getUpdateFixture(value)

				await delay(1) // delay to ensure updatedAt is different to createdAt

				const updated = await update(project, written.versionId, updateValue)

				const updatedReRead = await project[schemaName].getByDocId(
					written.docId,
				)
				// 'return of update() matched return of getByDocId()'
				expect(updated).toEqual(updatedReRead)

				// 'expected value is updated'
				expect(removeUndefinedFields(updated)).toEqual(
					jasmine.objectContaining(updateValue),
				)

				// 'updatedAt has changed'
				expect(written.updatedAt).not.toEqual(updated.updatedAt)

				// 'createdAt does not change'
				expect(written.createdAt).toEqual(updated.createdAt)

				// 'originalVersionId does not change'
				expect(written.originalVersionId).toEqual(updated.originalVersionId)
			})

			it(`getMany (${schemaName})`, async () => {
				const projectId = await comapeo.createProject()
				const project = await comapeo.getProject(projectId)
				const written = await createWithMockData(
					project,
					schemaName,
					CREATE_COUNT,
				)
				const expectedWithoutDeleted = []
				const deletePromises = []
				for (const [i, doc] of written.entries()) {
					// delete every 3rd doc
					if (i % 3 === 0) {
						deletePromises.push(project[schemaName].delete(doc.docId))
					} else {
						expectedWithoutDeleted.push(doc)
					}
				}
				const deleted = await Promise.all(deletePromises)
				const expectedWithDeleted = [...expectedWithoutDeleted, ...deleted]
				const manyWithoutDeleted = await project[schemaName].getMany()

				// 'expected values returns from getMany()'
				expect(sortById(manyWithoutDeleted)).toEqual(
					sortById(expectedWithoutDeleted),
				)

				const manyWithDeleted = await project[schemaName].getMany({
					includeDeleted: true,
				})

				// 'expected values returns from getMany({ includeDeleted: true })'
				expect(sortById(manyWithDeleted)).toEqual(sortById(expectedWithDeleted))
			})

			it(`create, close and then create, update (${schemaName})`, async () => {
				const projectId = await comapeo.createProject()
				const project = await comapeo.getProject(projectId)
				const values = new Array(5).fill(null).map(() => {
					return getUpdateFixture(value)
				})
				for (const value of values) {
					await create(project, value)
				}
				const written = await create(project, value)

				await project.close()

				// 'should fail updating since the project is already closed'
				await expectAsync(
					(async () => {
						const updateValue = getUpdateFixture(value)
						await update(project, written.versionId, updateValue)
					})(),
				).toBeRejected()

				// 'should fail creating since the project is already closed'
				await expectAsync(
					(async () => {
						for (const value of values) {
							await create(project, value)
						}
					})(),
				).toBeRejected()

				// 'should fail getting since the project is already closed'
				await expectAsync(
					(async () => {
						await project[schemaName].getMany()
					})(),
				).toBeRejected()
			})

			it(`create, read, close, re-open, read (${schemaName})`, async () => {
				const projectId = await comapeo.createProject()

				let project = await comapeo.getProject(projectId)

				const values = new Array(5).fill(null).map(() => {
					return getUpdateFixture(value)
				})

				for (const value of values) {
					await create(project, value)
				}

				const many1 = await project[schemaName].getMany()
				const manyValues1 = many1.map((doc) => valueOf(doc))

				// close it
				await project.close()

				// re-open project
				project = await comapeo.getProject(projectId)

				const many2 = await project[schemaName].getMany()
				const manyValues2 = many2.map((doc) => valueOf(doc))

				// 'expected values returned before closing and after re-opening'
				expect(removeUndefinedFields(manyValues1)).toEqual(
					removeUndefinedFields(manyValues2),
				)
			})

			it(`create and delete (${schemaName})`, async () => {
				const projectId = await comapeo.createProject()
				const project = await comapeo.getProject(projectId)
				const written = await createWithMockData(
					project,
					schemaName,
					CREATE_COUNT,
				)
				const deleted = await Promise.all(
					written.map((doc) => project[schemaName].delete(doc.docId)),
				)
				const read = await Promise.all(
					written.map((doc) => project[schemaName].getByDocId(doc.docId)),
				)

				// 'all docs are deleted'
				expect(deleted.every((doc) => doc.deleted)).toBeTrue()

				// 'return create() matches return of getByDocId()'
				expect(sortById(deleted)).toEqual(sortById(read))
			})

			it(`delete forks ${schemaName}`, async () => {
				const projectId = await comapeo.createProject()
				const project = await comapeo.getProject(projectId)
				const written = await create(project, value)
				const updateValue = getUpdateFixture(value)
				const updatedFork1 = await update(
					project,
					written.versionId,
					updateValue,
				)
				const updatedFork2 = await update(
					project,
					written.versionId,
					updateValue,
				)
				const updatedReRead = await project[schemaName].getByDocId(
					written.docId,
				)

				// 'return of update() matched return of getByDocId()'
				expect(updatedFork2).toEqual(updatedReRead)

				// 'doc is forked'
				expect(updatedReRead.forks).toEqual([updatedFork1.versionId])

				const deleted = await project[schemaName].delete(written.docId)

				// 'doc is deleted'
				expect(deleted.deleted).toBeTrue()

				// 'forks are deleted'
				expect(deleted.forks.length).toEqual(0)

				const deletedReRead = await project[schemaName].getByDocId(
					written.docId,
				)

				// 'doc is deleted'
				expect(deletedReRead.deleted).toBeTrue()

				// 'forks are deleted'
				expect(deletedReRead.forks.length).toEqual(0)
			})
		}
	})
}

function createWithMockData(
	project: MapeoProjectApi,
	schemaName:
		| 'field'
		| 'observation'
		| 'preset'
		| 'track'
		| 'remoteDetectionAlert',
	count: number,
) {
	switch (schemaName) {
		case 'field':
			return Promise.all(
				generate(schemaName, { count }).map((doc) =>
					project[schemaName].create(valueOf(doc)),
				),
			)
		case 'observation':
			return Promise.all(
				generate(schemaName, { count }).map((doc) =>
					project[schemaName].create(valueOf(doc)),
				),
			)
		case 'preset':
			return Promise.all(
				generate(schemaName, { count }).map((doc) =>
					project[schemaName].create(valueOf(doc)),
				),
			)
		case 'remoteDetectionAlert':
			return Promise.all(
				generate(schemaName, { count }).map((doc) =>
					project[schemaName].create(valueOf(doc)),
				),
			)
		case 'track':
			return Promise.all(
				generate(schemaName, { count }).map((doc) =>
					project[schemaName].create(valueOf(doc)),
				),
			)
		default:
			throw new Error(`Unexpected value: ${schemaName}`)
	}
}

function trackPositionFixture() {
	return {
		timestamp: randomDate().toISOString(),
		mocked: randomBool(),
		coords: {
			latitude: randomNum({ min: -90, max: 90, precision: 6 }),
			longitude: randomNum({ min: -180, max: 180, precision: 6 }),
			altitude: randomNum({ min: 0, max: 5000 }),
			accuracy: randomNum({ min: 0, max: 100, precision: 2 }),
			heading: randomNum({ min: 0, max: 360, precision: 6 }),
			speed: randomNum({ min: 0, max: 100, precision: 2 }),
		},
	}
}

function getUpdateFixture<T extends ComapeoValue>(value: T): T {
	switch (value.schemaName) {
		case 'observation':
			return {
				...value,
				lon: round(Math.random() * 180, 6),
				lat: round(Math.random() * 90, 6),
			}
		case 'preset':
			return {
				...value,
				fieldRefs: [
					{
						docId: uint8ArrayToHex(getRandomBytes(32)),
						versionId: `${uint8ArrayToHex(getRandomBytes(32))}/0`,
					},
				],
			}
		case 'field':
			return {
				...value,
				label: uint8ArrayToHex(getRandomBytes(10)),
			}
		case 'track':
			return {
				...value,
				tags: {
					foo: 'bar',
				},
			}
		default:
			return { ...value }
	}
}

/**
 * Create a doc for this test.
 *
 * Only supports the schema names we use in this test file, but should be easy
 * to extend if we add new ones.
 *
 * This function has a bunch of repeated code. In a perfect world, we wouldn't
 * need to do this. Instead, we'd just do:
 *
 *     project[value.schemaName].create(value)
 *
 * Unfortunately, this doesn't type check because each schema name's `create`
 * function is incompatible with the others. See [this TypeScript playground][0]
 * for a minimal reproduction of this problem.
 *
 * [0]: https://www.typescriptlang.org/play/?#code/JYOwLgpgTgZghgYwgAgGIHt3IN4ChnIyYBcyIArgLYBG0A3LgL666iSyIoBCcUO+yar1IUa9JiwToQAZzDIANugDmy6MgC8-AkXSkAPABVkEAB6QQAExlpMAPgAUANzgLyEUoYCUmu8imy6AoQAHRKys6u7iG6XgA0AkJQBsZmFtbIPFCOLm4eyN6+-tIyQaHhkXkhSfFMDLgBcsjoAA5gwCWayADaAES6vXHIvUm9ALrIcDaNYAxEfA4zzW0dIM0wy+0lPngES+jUAFakGFgAPpm8Xa1baxr3wwPIAPw4hCTIAIzIjMik2IJhMgAEw-BgEcJqKDdG6rMYOA6HLwMRhAA
 */
function create(
	project: MapeoProjectApi,
	value:
		| FieldValue
		| ObservationValue
		| PresetValue
		| TrackValue
		| RemoteDetectionAlertValue,
): Promise<ComapeoDoc> {
	switch (value.schemaName) {
		case 'field':
			return project[value.schemaName].create(value)
		case 'observation':
			return project[value.schemaName].create(value)
		case 'preset':
			return project[value.schemaName].create(value)
		case 'remoteDetectionAlert':
			return project[value.schemaName].create(value)
		case 'track':
			return project[value.schemaName].create(value)
		default:
			throw new Error(`Unexpected value: ${value}`)
	}
}

/**
 * Update a doc. See above for why this function exists.
 */
function update(
	project: MapeoProjectApi,
	versionId: string,
	value:
		| FieldValue
		| ObservationValue
		| PresetValue
		| TrackValue
		| RemoteDetectionAlertValue,
): Promise<ComapeoDoc> {
	switch (value.schemaName) {
		case 'field':
			return project[value.schemaName].update(versionId, value)
		case 'observation':
			return project[value.schemaName].update(versionId, value)
		case 'preset':
			return project[value.schemaName].update(versionId, value)
		case 'remoteDetectionAlert':
			return project[value.schemaName].update(versionId, value)
		case 'track':
			return project[value.schemaName].update(versionId, value)
		default:
			throw new Error(`Unexpected value: ${value}`)
	}
}
