/*
*                      Copyright 2022 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
import { BuiltinTypes, Element, Field, isInstanceElement, isObjectType, ListType, Values } from '@salto-io/adapter-api'
import { safeJsonStringify } from '@salto-io/adapter-utils'
import { logger } from '@salto-io/logging'

const log = logger(module)

export const covertFields = (
  elements: Element[],
  typeName: string,
  fieldsFieldName: string,
): void => {
  const type = elements.filter(isObjectType).find(objType => objType.elemID.name === typeName)

  if (type === undefined) {
    log.warn(`${typeName} type was not found`)
  } else {
    type.fields[fieldsFieldName] = new Field(
      type,
      fieldsFieldName,
      new ListType(BuiltinTypes.STRING)
    )
  }
  elements
    .filter(isInstanceElement)
    .filter(instance => instance.elemID.typeName === typeName)
    .forEach(instance => {
      instance.value[fieldsFieldName] = instance.value[fieldsFieldName]
        ?.filter((field: Values) => {
          if (field.id === undefined) {
            log.warn(`Received ${fieldsFieldName} item without id ${safeJsonStringify(field)} in instance ${instance.elemID.getFullName()}`)
            return false
          }
          return true
        })
        .map(({ id }: Values) => id)
    })
}