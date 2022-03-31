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
import { createReorderFilterCreator, deployFuncCreator } from './creator'

export const ORDER_FIELD_NAME = 'ids'

/**
 * Add automation order element with all the automations ordered
 */
const filterCreator = createReorderFilterCreator({
  typeName: 'automation',
  orderFieldName: ORDER_FIELD_NAME,
  iterateesToSortBy: [
    instance => !instance.value.active,
    instance => instance.value.position,
    instance => instance.value.title,
  ],
  deployFunc: deployFuncCreator('automations'),
})

export default filterCreator