import { snakeCase, startCase, camelCase } from 'lodash'
/* eslint-disable class-methods-use-this */
import { Field, ValueTypeField, SaveResult } from 'jsforce'
import {
  Type,
  TypesRegistry,
  ObjectType,
  TypeID,
  PrimitiveTypes
} from 'adapter-api'
import { isArray } from 'util'
import SalesforceClient from './client'
import * as constants from './constants'
import {
  CustomObject,
  CustomField,
  FieldPermissions,
  ProfileInfo,
  CompleteSaveResult,
  SfError
} from './salesforce_types'

// TODO: this should be replaced with Elements from core once ready
type Config = Record<string, any>

const sfCase = (name: string, custom: boolean = false): string =>
  startCase(camelCase(name)) + (custom === true ? '__c' : '')
const bpCase = (name: string): string =>
  name.endsWith('__c') ? snakeCase(name).slice(0, -3) : snakeCase(name)

// Diagnose client results
const diagnose = (result: SaveResult | SaveResult[]): void => {
  const errorMessage = (error: SfError | SfError[]): string => {
    if (isArray(error)) {
      return error.map(e => e.message).join('\n')
    }
    return error.message
  }

  let errors: string[] = []
  if (isArray(result)) {
    errors = errors.concat(
      (result as CompleteSaveResult[])
        .filter(r => r.errors !== undefined)
        .map(r => errorMessage(r.errors))
    )
  } else if ((result as CompleteSaveResult).errors) {
    errors.push(errorMessage((result as CompleteSaveResult).errors))
  }

  if (errors.length > 0) {
    // TODO: use CrudError
    throw Error(errors.join('\n'))
  }
}

// Add API name and label annotation if missing
const annotateApiNameAndLabel = (element: ObjectType): void => {
  const innerAnnotate = (obj: Type, name: string): void => {
    if (!obj.annotationsValues[constants.API_NAME]) {
      obj.annotate({
        [constants.API_NAME]: sfCase(name, true)
      })
    }
    if (!obj.annotationsValues[constants.LABEL]) {
      obj.annotate({ [constants.LABEL]: sfCase(name) })
    }
  }

  innerAnnotate(element, element.typeID.name)
  Object.entries(element.fields).forEach(([fieldName, field]): void => {
    innerAnnotate(field, fieldName)
  })
}

const fieldFullName = (typeApiName: string, fieldApiName: string): string =>
  `${typeApiName}.${fieldApiName}`

const toCustomField = (
  field: Type,
  fullname: boolean = false,
  objectName: string = ''
): CustomField =>
  new CustomField(
    fullname
      ? fieldFullName(objectName, field.annotationsValues[constants.API_NAME])
      : field.annotationsValues[constants.API_NAME],
    field.typeID.name,
    field.annotationsValues[constants.LABEL],
    field.annotationsValues[constants.REQUIRED],
    field.annotationsValues[constants.PICKLIST_VALUES]
  )

const toCustomObject = (element: ObjectType): CustomObject =>
  new CustomObject(
    element.annotationsValues[constants.API_NAME],
    element.annotationsValues[constants.LABEL],
    Object.values(element.fields).map(f => toCustomField(f))
  )

const apiName = (element: Type): string => {
  return element.annotationsValues[constants.API_NAME]
}

export default class SalesforceAdapter {
  readonly client: SalesforceClient
  // type registery used in discover
  readonly types = new TypesRegistry()

  constructor(conf: Config) {
    this.client = new SalesforceClient(
      conf.username,
      conf.password + conf.token,
      conf.sandbox
    )
  }

  private getType(name: string): Type {
    const typeName = bpCase(name)
    switch (typeName) {
      case 'string': {
        return this.types
          .getType(new TypeID({ adapter: '', name }), PrimitiveTypes.STRING)
          .clone()
      }
      case 'double': {
        return this.types
          .getType(
            new TypeID({ adapter: '', name: 'number' }),
            PrimitiveTypes.NUMBER
          )
          .clone()
      }
      case 'boolean': {
        return this.types
          .getType(
            // TODO: take checkbox from constans
            new TypeID({ adapter: constants.SALESFORCE, name: 'checkbox' })
          )
          .clone()
      }
      default: {
        return this.types
          .getType(new TypeID({ adapter: constants.SALESFORCE, name }))
          .clone()
      }
    }
  }

  /**
   * Discover configuration elements (types and instances in the given salesforce account)
   * Account credentials were given in the constructor.
   */
  public async discover(): Promise<Type[]> {
    // TODO: add here salesforce primitive data types
    const result = await Promise.all([
      this.discoverSObjects(),
      this.discoverMetadataTypes()
    ])
    return result[0].concat(result[1])
  }

  /**
   * Add new type element
   * @param element the object to add
   * @returns the updated object with extra info like api name and label
   * @throws error in case of failure
   */
  public async add(element: ObjectType): Promise<ObjectType> {
    const post = element.clone()
    annotateApiNameAndLabel(post)

    const result = await this.client.create(
      constants.CUSTOM_OBJECT,
      toCustomObject(post)
    )
    diagnose(result)

    const persmissionsResult = await this.updatePermissions(
      apiName(post),
      Object.values(post.fields).map(f => apiName(f))
    )
    diagnose(persmissionsResult)

    return post
  }

  /**
   * Remove an element
   * @param type The metadata type of the element to remove
   * @param element The provided element to remove
   * @returns true for success, false for failure
   */
  public async remove(element: ObjectType): Promise<void> {
    const result = await this.client.delete(
      constants.CUSTOM_OBJECT,
      apiName(element)
    )
    diagnose(result)
  }

  /**
   * Updates a custom object
   * @param prevElement The metadata of the old object
   * @param newElement The new metadata of the object to replace
   * @returns true for success, false for failure
   */
  public async update(
    prevElement: ObjectType,
    newElement: ObjectType
  ): Promise<ObjectType> {
    const post = newElement.clone()
    annotateApiNameAndLabel(post)

    if (apiName(post) !== apiName(prevElement)) {
      throw Error(
        `Failed to update element as api names pre=${apiName(
          prevElement
        )} and post=${apiName(post)} are different`
      )
    }

    // Retrieve the custom fields for deletion (those that appear in the old object and not in the new)
    // and delete them
    await this.deleteCustomFields(
      apiName(prevElement),
      Object.entries(prevElement.fields)
        .filter(field =>
          prevElement.getFieldsThatAreNotInOther(post).includes(field[0])
        )
        .map(field => apiName(field[1]))
    )

    // Retrieve the custom fields for addition (those that appear in the new object and not in the old)
    // and create the custom fields and update the permissions
    await this.createFields(
      apiName(post),
      Object.entries(post.fields)
        .filter(field =>
          post.getFieldsThatAreNotInOther(prevElement).includes(field[0])
        )
        .map(field => field[1])
    )

    // TODO: Update the rest of the attributes in the retrieved old object and call the update method
    return post
  }

  /**
   * Creates custom fields and their corresponding field permissions
   * @param relatedObjectApiName the object that the fields belong to
   * @param fieldsToAdd The fields to create
   * @returns successfully managed to create all fields with their permissions or not
   */
  private async createFields(
    relatedObjectApiName: string,
    fieldsToAdd: Type[]
  ): Promise<void> {
    if (fieldsToAdd.length === 0) return

    // Create the custom fields
    const result = await this.client.create(
      constants.CUSTOM_FIELD,
      fieldsToAdd.map(f => toCustomField(f, true, relatedObjectApiName))
    )
    diagnose(result)

    // Create the permissions
    // Build the permissions in a Profile object for all the custom fields we will add
    const permissionsResult = await this.updatePermissions(
      relatedObjectApiName,
      fieldsToAdd.map(apiName)
    )
    diagnose(permissionsResult)
  }

  /**
   * Creates permissions in a Profile object for custom fields
   * @param fieldsForAddition The custom fields we create the permissions for
   * @returns A ProfileInfo object that contains all the required permissions
   */
  private async updatePermissions(
    objectApiName: string,
    fieldsApiName: string[]
  ): Promise<SaveResult | SaveResult[]> {
    return this.client.update(
      constants.METADATA_PROFILE_OBJECT,
      new ProfileInfo(
        constants.PROFILE_NAME_SYSTEM_ADMINISTRATOR,
        fieldsApiName.map(f => ({
          field: fieldFullName(objectApiName, f),
          editable: true,
          readable: true
        }))
      )
    )
  }

  /**
   * Deletes custom fields
   * @param objectApiName the object api name those fields reside in
   * @param fieldsApiName the custom fields we wish to delete
   */
  private async deleteCustomFields(
    objectApiName: string,
    fieldsApiName: string[]
  ): Promise<void> {
    if (fieldsApiName.length === 0) {
      return
    }

    const result = await this.client.delete(
      constants.CUSTOM_FIELD,
      fieldsApiName.map(field => fieldFullName(objectApiName, field))
    )
    diagnose(result)
  }

  private async discoverMetadataTypes(): Promise<Type[]> {
    const objects = await this.client.listMetadataTypes()
    return Promise.all(
      objects
        .filter(obj => {
          return obj.xmlName !== constants.CUSTOM_OBJECT
        })
        .map(async obj => this.createMetadataTypeElement(obj.xmlName))
    )
  }

  private async createMetadataTypeElement(objectName: string): Promise<Type> {
    const element = this.getType(objectName) as ObjectType
    element.annotate({ [constants.API_NAME]: objectName })
    const fields = await this.client.discoverMetadataObject(objectName)
    if (!fields) {
      return element
    }
    fields.forEach(field => {
      if (field.name !== constants.METADATA_OBJECT_NAME_FIELD) {
        const fieldElement = this.createMetadataFieldTypeElement(field)
        fieldElement.annotate({ [constants.API_NAME]: field.name })
        element.fields[bpCase(field.name)] = fieldElement
      }
    })
    return element
  }

  private createMetadataFieldTypeElement(field: ValueTypeField): Type {
    const element = this.getType(field.soapType) as ObjectType
    element.annotationsValues.required = field.valueRequired

    if (field.picklistValues && field.picklistValues.length > 0) {
      element.annotationsValues.values = field.picklistValues.map(
        val => val.value
      )
      const defaults = field.picklistValues
        .filter(val => {
          return val.defaultValue === true
        })
        .map(val => val.value)
      if (defaults.length === 1) {
        // eslint-disable-next-line no-underscore-dangle
        element.annotationsValues[Type.DEFAULT] = defaults.pop()
      } else {
        // eslint-disable-next-line no-underscore-dangle
        element.annotationsValues[Type.DEFAULT] = defaults
      }
    }

    return element
  }

  private async discoverSObjects(): Promise<Type[]> {
    const sobjects = await Promise.all(
      (await this.client.listSObjects()).map(async obj =>
        this.createSObjectTypeElement(obj.name)
      )
    )
    // discover permissions per field - we do this post element creation as we
    // fetch permssions for all fields in single call.
    const permissions = await this.discoverPermissions()
    // add field permissions to all discovered elements
    sobjects.forEach(sobject => {
      Object.values(sobject.fields).forEach(field => {
        const fieldPermission = permissions.get(
          `${sobject.annotationsValues[constants.API_NAME]}.${
            field.annotationsValues[constants.API_NAME]
          }`
        )
        if (fieldPermission) {
          // eslint-disable-next-line no-param-reassign
          field.annotationsValues[constants.FIELD_LEVEL_SECURITY] = {}
          fieldPermission.forEach((profilePermission, profile) => {
            // eslint-disable-next-line no-param-reassign
            field.annotationsValues[constants.FIELD_LEVEL_SECURITY][
              bpCase(profile)
            ] = {
              editable: profilePermission.editable,
              readable: profilePermission.readable
            }
          })
        }
      })
    })
    return sobjects
  }

  private async createSObjectTypeElement(
    objectName: string
  ): Promise<ObjectType> {
    const element = this.getType(objectName) as ObjectType
    element.annotate({ [constants.API_NAME]: objectName })
    const fields = await this.client.discoverSObject(objectName)
    fields.forEach(field => {
      const fieldElement = this.createSObjectFieldTypeElement(field)
      fieldElement.annotate({ [constants.API_NAME]: field.name })
      element.fields[bpCase(field.name)] = fieldElement
    })
    return element
  }

  /**
   * Discover all sobject field permissions
   * return fullFieldName -> (profile -> permissions)
   */
  private async discoverPermissions(): Promise<
    Map<string, Map<string, FieldPermissions>>
  > {
    const profiles = await this.client.listMetadataObjects(
      constants.METADATA_PROFILE_OBJECT
    )
    const profilesInfo = await Promise.all(
      profiles.map(prof => {
        return this.client.readMetadata(
          constants.METADATA_PROFILE_OBJECT,
          prof.fullName
        ) as Promise<ProfileInfo>
      })
    )

    const permissions = new Map<string, Map<string, FieldPermissions>>()
    profilesInfo.forEach(info => {
      info.fieldPermissions.forEach(fieldPermission => {
        const name = fieldPermission.field
        if (!permissions.has(name)) {
          permissions.set(name, new Map<string, FieldPermissions>())
        }
        permissions.get(name).set(info.fullName, fieldPermission)
      })
    })

    return permissions
  }

  private createSObjectFieldTypeElement(field: Field): Type {
    const element: Type = this.getType(field.type)
    const annotations = element.annotationsValues
    annotations[constants.LABEL] = field.label
    annotations[constants.REQUIRED] = field.nillable
    annotations[Type.DEFAULT] = field.defaultValue

    if (field.picklistValues && field.picklistValues.length > 0) {
      annotations[constants.PICKLIST_VALUES] = field.picklistValues.map(
        val => val.value
      )
      annotations[constants.RESTRICTED_PICKLIST] = false
      if (field.restrictedPicklist) {
        annotations[constants.RESTRICTED_PICKLIST] = field.restrictedPicklist
      }

      const defaults = field.picklistValues
        .filter(val => {
          return val.defaultValue === true
        })
        .map(val => val.value)
      if (defaults.length > 0) {
        if (field.type === 'picklist') {
          annotations[Type.DEFAULT] = defaults.pop()
        } else {
          annotations[Type.DEFAULT] = defaults
        }
      }
    }

    return element
  }
}
